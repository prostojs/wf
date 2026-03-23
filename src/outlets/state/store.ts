import type { WfState } from '../types';

/**
 * Backend for HandleStateStrategy.
 *
 * Built-in: WfStateStoreMemory (dev/testing).
 * Production: implement for your database.
 */
export interface WfStateStore {
    /** Store state under a handle with optional expiry timestamp (ms). */
    set(handle: string, state: WfState, expiresAt?: number): Promise<void>;
    /** Retrieve state by handle. Returns null if not found. */
    get(
        handle: string,
    ): Promise<{ state: WfState; expiresAt?: number } | null>;
    /** Delete a handle (for consume/revocation). */
    delete(handle: string): Promise<void>;
    /** Atomically retrieve and delete a handle. Returns null if not found. */
    getAndDelete(
        handle: string,
    ): Promise<{ state: WfState; expiresAt?: number } | null>;
    /** Remove all expired entries. Returns count removed. Optional. */
    cleanup?(): Promise<number>;
}
