import type { WfState } from '../types';
import type { WfPersistOptions } from './ttl';

/** A consumed token's state and absolute expiry (see `consumeEntry`). */
export interface WfConsumedEntry {
    state: WfState;
    /**
     * Absolute expiry as a ms timestamp. `0` = never expires.
     * `undefined` = UNKNOWN (e.g. an entry written by 0.2.x to a store that
     * does not return `expiresAt`): callers MUST NOT restore such a state,
     * because any expiry they pick may extend the token.
     */
    expiresAt: number | undefined;
}

/** A persisted token and the absolute expiry applied (see `persistEntry`). */
export interface WfPersistedEntry {
    token: string;
    /**
     * Absolute expiry as a ms timestamp. `0` = never expires. `undefined` =
     * unknown (a built-in strategy whose `persist()` a subclass overrides).
     */
    expiresAt: number | undefined;
}

/**
 * Strategy for persisting workflow state between round-trips.
 *
 * Two built-in strategies:
 * - `EncapsulatedStateStrategy` — self-contained encrypted token (no server storage).
 * - `HandleStateStrategy` — server-side storage, only a short handle travels.
 *
 * ## Security note — token replay
 *
 * The resumption token allows the holder to continue the workflow from the
 * point where it was paused. This means any reuse of a live token re-executes
 * the step handler at that point, which is safe for idempotent data-collection
 * steps but dangerous for steps with real-world side effects (financial
 * transactions, credential changes, account provisioning).
 *
 * Single-use invalidation is provided via `consume()`:
 *
 * - `HandleStateStrategy.consume()` atomically deletes the server-side handle
 *   (via `WfStateStore.getAndDelete`), so a consumed token cannot be reused.
 *
 * - `EncapsulatedStateStrategy.consume()` is identical to `retrieve()` — the
 *   strategy is stateless and cannot enforce single-use. A copy of the
 *   encrypted token remains valid for the full TTL regardless of any consume
 *   call. See `EncapsulatedStateStrategy` for guidance on when this is
 *   acceptable.
 *
 * Higher-level layers (e.g. `@wooksjs/event-wf`'s outlet trigger) should call
 * `consume()` on every resume to get single-use semantics where the strategy
 * supports it.
 */
export interface WfStateStrategy {
    /**
     * Persist workflow state. Returns a token that can be used to retrieve it.
     *
     * @param state     — workflow state (schemaId, context, indexes)
     * @param options   — optional `ttl` (ms) and/or absolute `expiresAt`
     *                    (ms timestamp, 0 = never); the earlier wins. See
     *                    `WfPersistOptions`.
     * @param overrides — optional storage hints (see below)
     * @returns opaque token string (encrypted blob or DB handle)
     *
     * ## `overrides.handle` — hint, not requirement
     *
     * When supplied, a strategy MAY use the given string as its storage key
     * (re-using or overwriting any existing entry at that key). A strategy MAY
     * also ignore the hint and mint a fresh token — `EncapsulatedStateStrategy`
     * always does, because its token IS the ciphertext of the state. Callers
     * MUST NOT depend on the returned token equaling the hint, and strategies
     * MUST NOT throw on an unsupported hint.
     *
     * ### Security: handle entropy is the caller's responsibility
     *
     * For strategies that honor the hint (e.g. `HandleStateStrategy`), the
     * supplied `handle` becomes the storage key and OVERWRITES any existing
     * entry at that key. Callers MUST supply a value with sufficient entropy
     * to prevent collision with or hijacking of unrelated workflow state —
     * typically by forwarding a token that was just returned by `persist()`
     * or read from a trusted transport, never by deriving it from
     * attacker-influenced input.
     *
     * ### Security: re-persisting a consumed handle defeats single-use
     *
     * `HandleStateStrategy.consume()` deletes the server-side entry to
     * provide single-use semantics. Calling `persist(state, _, { handle: T })`
     * after `consume(T)` re-establishes the entry under the same key, so any
     * surviving copy of `T` becomes valid again. This is the intended
     * mechanic for "stable workflow session" tokens (e.g. `@wooksjs/event-wf`)
     * where every step is idempotent, but it MUST NOT be used for steps with
     * privileged side effects (credential changes, financial operations,
     * account provisioning). For those, let `persist()` mint a fresh handle.
     */
    persist(
        state: WfState,
        options?: WfPersistOptions,
        overrides?: { handle?: string },
    ): Promise<string>;

    /**
     * Retrieve workflow state from a token WITHOUT invalidating it.
     * Returns null if token is invalid, expired, or tampered with.
     *
     * MUST be side-effect free: it never invalidates, extends or changes the
     * token or its state. Callers rely on this to inspect a token before
     * deciding whether to `consume()` it (e.g. an allow/block check that must
     * leave a refused token usable).
     *
     * Prefer `consume()` for callers that advance the workflow — retaining a
     * live token after use enables replay.
     */
    retrieve(token: string): Promise<WfState | null>;

    /**
     * Atomically retrieve AND invalidate the token. Returns null if the token
     * is invalid, expired, or already consumed.
     *
     * A strategy that supports single use MUST make this atomic: among
     * concurrent `consume()` calls for the same token, at most one returns
     * the state. Never implement it as `retrieve()` followed by a separate
     * delete — any `await` in between lets a second caller win too.
     *
     * For `HandleStateStrategy` this is truly single-use and race-safe —
     * backed by the store's atomic `getAndDelete` (see `WfStateStore`).
     *
     * For `EncapsulatedStateStrategy` this is identical to `retrieve()` — the
     * strategy has no server-side state to delete, so a copy of the token
     * remains valid for the full TTL. Use `HandleStateStrategy` if single-use
     * is a security requirement.
     */
    consume(token: string): Promise<WfState | null>;

    /**
     * Optional: `persist()` that also returns the absolute expiry it applied
     * — see `WfPersistedEntry` (`0` = never expires).
     *
     * Implementing it is the signal that the strategy HONOURS
     * `options.expiresAt` (and the "earlier of `ttl`/`expiresAt` wins" rule).
     * A strategy without it may read only `ttl` (strategies written against
     * 0.2.x do), so callers with an absolute expiry should use
     * `persistEntry()` when present and otherwise fall back to `persist()`
     * with a `ttl` (as `mintWfStateToken` does).
     *
     * MUST NOT bypass a customised `persist()`: the built-ins delegate to an
     * overriding `persist()` (with `expiresAt` folded into `ttl`) and then
     * report the expiry as unknown.
     */
    persistEntry?(
        state: WfState,
        options?: WfPersistOptions,
        overrides?: { handle?: string },
    ): Promise<WfPersistedEntry>;

    /**
     * Optional: `consume()` that also returns the absolute expiry of the
     * consumed token — see `WfConsumedEntry` (`0` = never expires,
     * `undefined` = unknown). `null` if the token is invalid, expired or
     * already consumed.
     *
     * MUST have exactly the atomicity of `consume()`, and MUST NOT bypass a
     * customised `consume()` (the built-ins delegate to an overriding
     * `consume()` and then report the expiry as unknown).
     *
     * To put a consumed state back without extending it, restore only when
     * the expiry is known, and only through a strategy that honours
     * `expiresAt` (`persistEntry`):
     *
     * @example
     * const entry = await strategy.consumeEntry(token);
     * // ...the step fails; restore the token without extending it:
     * if (entry.expiresAt !== undefined && strategy.persistEntry) {
     *     await strategy.persistEntry(entry.state, { expiresAt: entry.expiresAt }, { handle: token });
     * }
     *
     * `EncapsulatedStateStrategy` returns the expiry its token carries and,
     * as with `consume()`, does not invalidate the token.
     */
    consumeEntry?(token: string): Promise<WfConsumedEntry | null>;
}
