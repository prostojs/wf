import { randomUUID } from 'node:crypto';
import type { WfState } from '../types';
import type { WfStateStrategy } from './strategy';
import type { WfStateStore } from './store';

export interface HandleStateConfig {
    /** Storage backend */
    store: WfStateStore;
    /** Default TTL in ms. 0 = no expiry. */
    defaultTtl?: number;
    /** Custom handle generator (default: crypto.randomUUID) */
    generateHandle?: () => string;
}

export class HandleStateStrategy implements WfStateStrategy {
    constructor(private config: HandleStateConfig) {}

    async persist(state: WfState, options?: { ttl?: number }): Promise<string> {
        const handle = (this.config.generateHandle ?? randomUUID)();
        const ttl = options?.ttl ?? this.config.defaultTtl ?? 0;
        const expiresAt = ttl > 0 ? Date.now() + ttl : undefined;
        await this.config.store.set(handle, state, expiresAt);
        return handle;
    }

    async retrieve(token: string): Promise<WfState | null> {
        const entry = await this.config.store.get(token);
        return entry?.state ?? null;
    }

    async consume(token: string): Promise<WfState | null> {
        const entry = await this.config.store.getAndDelete(token);
        return entry?.state ?? null;
    }
}
