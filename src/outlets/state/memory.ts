import type { WfState } from '../types';
import type { WfStateStore, WfStateStoreEntry } from './store';

/**
 * In-memory state store for development and testing.
 * State is lost on process restart.
 *
 * Every operation runs synchronously inside its promise (there is no `await`
 * between reading and deleting an entry), so `getAndDelete` is atomic within
 * the process, as the `WfStateStore` contract requires.
 */
export class WfStateStoreMemory implements WfStateStore {
    private store = new Map<string, WfStateStoreEntry>();

    async set(
        handle: string,
        state: WfState,
        expiresAt?: number,
    ): Promise<void> {
        this.store.set(handle, { state, expiresAt });
    }

    async get(handle: string): Promise<WfStateStoreEntry | null> {
        return this.read(handle);
    }

    async delete(handle: string): Promise<void> {
        this.store.delete(handle);
    }

    async getAndDelete(handle: string): Promise<WfStateStoreEntry | null> {
        // Read and delete in the same synchronous turn — no await in between.
        const entry = this.read(handle);
        if (entry) this.store.delete(handle);
        return entry;
    }

    async cleanup(): Promise<number> {
        const now = Date.now();
        let count = 0;
        for (const [handle, entry] of this.store) {
            if (isExpired(entry, now)) {
                this.store.delete(handle);
                count++;
            }
        }
        return count;
    }

    /** Synchronous lookup; drops the entry when it has expired. */
    private read(handle: string): WfStateStoreEntry | null {
        const entry = this.store.get(handle);
        if (!entry) return null;
        if (isExpired(entry, Date.now())) {
            this.store.delete(handle);
            return null;
        }
        return entry;
    }
}

function isExpired(entry: WfStateStoreEntry, now: number): boolean {
    // `0` / `undefined` = never expires (kept for compatibility).
    return !!entry.expiresAt && now > entry.expiresAt;
}
