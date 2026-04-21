import type { WfState } from '../types';

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
     * @param state   — workflow state (schemaId, context, indexes)
     * @param options — optional TTL in milliseconds
     * @returns opaque token string (encrypted blob or DB handle)
     */
    persist(state: WfState, options?: { ttl?: number }): Promise<string>;

    /**
     * Retrieve workflow state from a token WITHOUT invalidating it.
     * Returns null if token is invalid, expired, or tampered with.
     *
     * Prefer `consume()` for callers that advance the workflow — retaining a
     * live token after use enables replay.
     */
    retrieve(token: string): Promise<WfState | null>;

    /**
     * Atomically retrieve AND invalidate the token. Returns null if the token
     * is invalid, expired, or already consumed.
     *
     * For `HandleStateStrategy` this is truly single-use and race-safe —
     * backed by the store's atomic `getAndDelete`.
     *
     * For `EncapsulatedStateStrategy` this is identical to `retrieve()` — the
     * strategy has no server-side state to delete, so a copy of the token
     * remains valid for the full TTL. Use `HandleStateStrategy` if single-use
     * is a security requirement.
     */
    consume(token: string): Promise<WfState | null>;
}
