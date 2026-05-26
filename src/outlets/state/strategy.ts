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
     * @param state     — workflow state (schemaId, context, indexes)
     * @param options   — optional TTL in milliseconds
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
        options?: { ttl?: number },
        overrides?: { handle?: string },
    ): Promise<string>;

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
