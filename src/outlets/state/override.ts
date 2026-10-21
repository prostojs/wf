import type { WfState } from '../types';
import type {
    WfConsumedEntry,
    WfPersistedEntry,
    WfStateStrategy,
} from './strategy';
import { foldToTtl } from './ttl';
import type { WfPersistOptions } from './ttl';

/*
 * Override bridge for the built-in strategies (internal).
 *
 * `consume()`/`persist()` are the long-standing extension points; the
 * `*Entry()` variants must never bypass a subclass (or instance) override of
 * them. When one is overridden, the entry variant delegates to it and reports
 * the expiry as unknown.
 *
 * TODO(0.4.0): invert this together with the `rawFallback` removal — make
 * `consumeEntry()`/`persistEntry()` the primary hooks, derive `consume()`/
 * `persist()` from them, and drop the prototype check.
 */

/** `instance[method]` is not the one defined on `base.prototype`. */
export function isOverridden(
    instance: WfStateStrategy,
    base: { prototype: WfStateStrategy },
    method: 'consume' | 'persist',
): boolean {
    return instance[method] !== base.prototype[method];
}

/** `consumeEntry()` through an overridden `consume()`: expiry unknown. */
export async function consumeViaOverride(
    strategy: WfStateStrategy,
    token: string,
): Promise<WfConsumedEntry | null> {
    const state = await strategy.consume(token);
    return state ? { state, expiresAt: undefined } : null;
}

/**
 * `persistEntry()` through an overridden `persist()`: the override may read
 * only `ttl`, so `expiresAt` is folded into it; expiry unknown.
 */
export async function persistViaOverride(
    strategy: WfStateStrategy,
    state: WfState,
    options: WfPersistOptions | undefined,
    overrides: { handle?: string } | undefined,
): Promise<WfPersistedEntry> {
    const token = await strategy.persist(state, foldToTtl(options), overrides);
    return { token, expiresAt: undefined };
}
