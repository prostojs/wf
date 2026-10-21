/*
 * Test-only store doubles shared by the specs. Not exported from the package.
 */
import type { WfState } from '../types';
import { WfStateStoreMemory } from './memory';
import type { WfStateStore, WfStateStoreEntry } from './store';

/** A copy of everything currently in a memory store. */
export function peek(mem: WfStateStoreMemory): Map<string, WfStateStoreEntry> {
    return new Map(
        (mem as unknown as { store: Map<string, WfStateStoreEntry> }).store,
    );
}

/** A store that forwards to a memory store, with some methods replaced. */
export function wrapMemory(
    over: (inner: WfStateStoreMemory) => Partial<WfStateStore> = () => ({}),
): { inner: WfStateStoreMemory; store: WfStateStore } {
    const inner = new WfStateStoreMemory();
    const store: WfStateStore = {
        set: (h, s, e) => inner.set(h, s, e),
        get: (h) => inner.get(h),
        delete: (h) => inner.delete(h),
        getAndDelete: (h) => inner.getAndDelete(h),
        ...over(inner),
    };
    return { inner, store };
}

/** A store whose key comparison runs every key through `norm` (collations). */
export function keyMapped(norm: (key: string) => string) {
    return wrapMemory((inner) => ({
        set: (h, s, e) => inner.set(norm(h), s, e),
        get: (h) => inner.get(norm(h)),
        delete: (h) => inner.delete(norm(h)),
        getAndDelete: (h) => inner.getAndDelete(norm(h)),
    }));
}

interface BackendRow {
    state: WfState;
    /** Backend expiry (Redis `PX`, Mongo TTL index). */
    px?: number;
    /** The lifetime the row was stored with. */
    life?: number;
}

/**
 * Expiry handled by the backend; rows come back as `{ state }` only (no
 * `expiresAt` echo), JSON round-tripped. `onGet` may mutate the row on every
 * `get()` (e.g. to model a sliding TTL).
 */
export class BackendTtlStore implements WfStateStore {
    readonly data = new Map<string, BackendRow>();
    constructor(private onGet?: (row: BackendRow) => void) {}
    private live(h: string) {
        const row = this.data.get(h);
        if (!row) return null;
        if (row.px && Date.now() > row.px) {
            this.data.delete(h);
            return null;
        }
        return row;
    }
    async set(h: string, state: WfState, e?: number) {
        this.data.set(h, {
            state: JSON.parse(JSON.stringify(state)),
            px: e,
            life: e ? e - Date.now() : undefined,
        });
    }
    async get(h: string) {
        const row = this.live(h);
        if (!row) return null;
        this.onGet?.(row);
        return { state: JSON.parse(JSON.stringify(row.state)) as WfState };
    }
    async delete(h: string) {
        this.data.delete(h);
    }
    async getAndDelete(h: string) {
        const row = this.live(h);
        if (row) this.data.delete(h);
        return row ? { state: row.state } : null;
    }
}
