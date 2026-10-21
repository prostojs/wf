import type { TFlowOutput } from '../types';
import type { WfState } from './types';
import type { WfStateStrategy } from './state/strategy';
import { assertBound, foldToTtl } from './state/ttl';
import type { WfPersistOptions } from './state/ttl';

/**
 * Anything that can start a workflow. `Workflow` from `@prostojs/wf` fits;
 * adapters pass an object that forwards to their own start function.
 */
export interface WfStartRunner<T, IR> {
    start(
        schemaId: string,
        context: T,
        input?: unknown,
    ): Promise<TFlowOutput<T, unknown, IR>>;
}

export interface WfMintOptions<T, IR> {
    /**
     * Where the paused state is persisted. A function picks the strategy
     * from the pause request (for adapters that let a step choose it).
     */
    strategy: WfStateStrategy | ((inputRequired: IR) => WfStateStrategy);
    /** Workflow to start. */
    schemaId: string;
    /** Initial workflow context. */
    context: T;
    /** Input for the first step. */
    input?: unknown;
    /**
     * Token lifetime in ms. `0` = never expires; any other value must be a
     * positive finite number (negative, `NaN` and `Infinity` throw a
     * `TypeError` before the flow runs). When the pausing step also returned
     * `expires`, the EARLIER of the two wins; with neither, the strategy's
     * `defaultTtl` applies.
     */
    ttl?: number;
    /**
     * Extra `state.meta` to persist with the paused state. A function gets
     * the pause request and the flow output.
     */
    meta?:
        | Record<string, unknown>
        | ((info: {
              inputRequired: IR;
              output: TFlowOutput<T, unknown, IR>;
          }) => Record<string, unknown>);
}

export type WfMintResult<T, IR> =
    | {
          /** Resumption token, as returned by `strategy.persist()`. */
          token: string;
          /** What the paused step asked for (outlet request). */
          inputRequired: IR;
          /**
           * Absolute expiry (ms timestamp), `0` = never. `undefined` when it
           * cannot be known: the strategy has no `persistEntry()`.
           */
          expiresAt: number | undefined;
          output: TFlowOutput<T, unknown, IR>;
      }
    | {
          /** The flow did not pause, so there is nothing to resume. */
          token: undefined;
          inputRequired: undefined;
          expiresAt: undefined;
          output: TFlowOutput<T, unknown, IR>;
      };

/**
 * Start a workflow without a request and persist it when it pauses: the
 * headless half of an outlet trigger, for server-initiated flows (invites,
 * scheduled approvals, admin-issued links).
 *
 * Returns the resumption token. The caller delivers it (e.g. in an email
 * link); this function does not call any outlet. A flow that finishes (or
 * fails without asking for input) yields no token. If the flow, the `meta`
 * function or the strategy picker throws, nothing is persisted and the error
 * propagates.
 *
 * Expiry: the earlier of `options.ttl` and the `expires` the pausing step
 * returned; with neither, the strategy default. The same rule as
 * `persist({ ttl, expiresAt })`. A strategy without `persistEntry()` (which
 * may read only `ttl`) receives the earlier bound as a `ttl` instead, at
 * least 1 ms. The token is always freshly minted, never a caller-chosen
 * handle.
 *
 * The token is the strategy's raw token. A token that must resume through a
 * `@wooksjs/event-wf` outlet trigger also needs the strategy-name prefix that
 * trigger expects; wooks will provide a wrapper for that.
 *
 * Use `HandleStateStrategy` (ideally with `hashHandles`) for invite-style
 * tokens: they are single-use, unlike `EncapsulatedStateStrategy` tokens.
 *
 * @example
 * const { token } = await mintWfStateToken(workflow, {
 *     strategy,
 *     schemaId: 'invite',
 *     context: { email: 'new.user@example.com' },
 *     ttl: 7 * 24 * 3600_000,
 * });
 * if (token) await sendInviteEmail(`https://app.example.com/invite?wfs=${token}`);
 */
export async function mintWfStateToken<T, IR>(
    runner: WfStartRunner<T, IR>,
    options: WfMintOptions<T, IR>,
): Promise<WfMintResult<T, IR>> {
    const { ttl } = options;
    if (ttl !== undefined) assertBound(ttl, 'mintWfStateToken(): ttl');
    const output = await runner.start(
        options.schemaId,
        options.context,
        options.input,
    );
    if (!output.inputRequired) {
        return {
            token: undefined,
            inputRequired: undefined,
            expiresAt: undefined,
            output,
        };
    }
    const inputRequired = output.inputRequired;
    const strategy =
        typeof options.strategy === 'function'
            ? options.strategy(inputRequired)
            : options.strategy;
    const extraMeta =
        typeof options.meta === 'function'
            ? options.meta({ inputRequired, output })
            : options.meta;
    const state: WfState = extraMeta
        ? {
              ...(output.state as WfState),
              meta: { ...output.state.meta, ...extraMeta },
          }
        : (output.state as WfState);
    const wanted: WfPersistOptions = {};
    if (ttl !== undefined) wanted.ttl = ttl;
    if (output.expires) wanted.expiresAt = output.expires;
    const persistOptions = Object.keys(wanted).length ? wanted : undefined;
    if (strategy.persistEntry) {
        const { token, expiresAt } = await strategy.persistEntry(
            state,
            persistOptions,
        );
        return { token, inputRequired, expiresAt, output };
    }
    // May read only `ttl`: fold the bounds into one; expiry unknown.
    const token = await strategy.persist(state, foldToTtl(persistOptions));
    return { token, inputRequired, expiresAt: undefined, output };
}
