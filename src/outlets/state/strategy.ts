import type { WfState } from '../types';

/**
 * Strategy for persisting workflow state between round-trips.
 *
 * Two built-in strategies:
 * - EncapsulatedStateStrategy: self-contained encrypted token (no server storage)
 * - HandleStateStrategy: server-side storage, only a short handle travels
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
     * Retrieve workflow state from a token.
     * Returns null if token is invalid, expired, or tampered with.
     */
    retrieve(token: string): Promise<WfState | null>;

    /**
     * Retrieve + invalidate. For single-use tokens (email magic links).
     * Returns null if token is invalid, expired, or already consumed.
     *
     * For EncapsulatedStateStrategy this is identical to retrieve()
     * (stateless — cannot truly invalidate). Use HandleStateStrategy
     * if single-use is critical.
     */
    consume(token: string): Promise<WfState | null>;
}
