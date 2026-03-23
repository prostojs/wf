import type { WfState } from '../types';
import type { WfStateStore } from './store';

/**
 * In-memory state store for development and testing.
 * State is lost on process restart.
 */
export class WfStateStoreMemory implements WfStateStore {
    private store = new Map<
        string,
        { state: WfState; expiresAt?: number }
    >();

    async set(
        handle: string,
        state: WfState,
        expiresAt?: number,
    ): Promise<void> {
        this.store.set(handle, { state, expiresAt });
    }

    async get(
        handle: string,
    ): Promise<{ state: WfState; expiresAt?: number } | null> {
        const entry = this.store.get(handle);
        if (!entry) return null;
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            this.store.delete(handle);
            return null;
        }
        return entry;
    }

    async delete(handle: string): Promise<void> {
        this.store.delete(handle);
    }

    async getAndDelete(
        handle: string,
    ): Promise<{ state: WfState; expiresAt?: number } | null> {
        const entry = await this.get(handle);
        if (entry) this.store.delete(handle);
        return entry;
    }

    async cleanup(): Promise<number> {
        const now = Date.now();
        let count = 0;
        for (const [handle, entry] of this.store) {
            if (entry.expiresAt && now > entry.expiresAt) {
                this.store.delete(handle);
                count++;
            }
        }
        return count;
    }
}
