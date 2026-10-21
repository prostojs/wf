/** Options accepted by `WfStateStrategy.persist()` / `persistEntry()`. */
export interface WfPersistOptions {
    /**
     * Lifetime in ms, counted from the persist call. Overrides the strategy's
     * `defaultTtl`. A non-positive or non-finite value means "never expires".
     */
    ttl?: number;
    /**
     * Absolute expiry as a ms timestamp, e.g. the `expiresAt` returned by
     * `consumeEntry()`, to put a state back with its exact original expiry.
     * `0` = never expires. When given, `defaultTtl` is not applied. A
     * timestamp in the past persists an already-expired entry.
     *
     * With both `ttl` and `expiresAt`, the EARLIER expiry wins ("never" loses
     * to any bound), so combining them can only shorten a lifetime.
     *
     * Only strategies that implement `persistEntry()` are guaranteed to honour
     * it (see `WfStateStrategy.persistEntry`).
     *
     * @throws TypeError unless `0` or a positive finite number.
     */
    expiresAt?: number;
}

/**
 * The absolute expiry (ms timestamp) a built-in strategy stores for a persist
 * call, or `undefined` for "never expires". See `WfPersistOptions` for the
 * rules. Custom strategies can use it to apply the same rules.
 *
 * @throws TypeError for an invalid `expiresAt`
 */
export function resolveExpiresAt(
    options: WfPersistOptions | undefined,
    defaultTtl: number | undefined,
    now: number = Date.now(),
): number | undefined {
    const absolute = options?.expiresAt;
    if (absolute !== undefined) assertBound(absolute, 'persist(): expiresAt');
    // `defaultTtl` only applies when the caller gave neither bound.
    const ttl =
        options?.ttl !== undefined || absolute === undefined
            ? resolveTtl(options?.ttl, defaultTtl)
            : 0;
    return earliest(ttl > 0 ? now + ttl : undefined, absolute);
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported from the package).
// ---------------------------------------------------------------------------

/**
 * The lifetime in ms for a persist call: the per-call `ttl` when defined,
 * otherwise `defaultTtl`. Anything that is not a positive finite number means
 * "never expires" and comes back as `0`.
 */
function resolveTtl(
    ttl: number | undefined,
    defaultTtl: number | undefined,
): number {
    const applied = ttl ?? defaultTtl ?? 0;
    return Number.isFinite(applied) && applied > 0 ? applied : 0;
}

/**
 * The earliest of the given expiry bounds (ms timestamps). `undefined`, `0`
 * and other non-positive values are not bounds; `undefined` when none is.
 */
export function earliest(
    ...bounds: Array<number | undefined>
): number | undefined {
    let min: number | undefined;
    for (const b of bounds) {
        if (b !== undefined && b > 0 && (min === undefined || b < min)) {
            min = b;
        }
    }
    return min;
}

/** @throws TypeError unless `value` is `0` (never) or a positive finite number. */
export function assertBound(value: number, label: string): void {
    if (value !== 0 && !(Number.isFinite(value) && value > 0)) {
        throw new TypeError(
            `${label} must be 0 (never) or a positive finite number, got ${String(value)}`,
        );
    }
}

/**
 * The options for a strategy that may read only `ttl` (one without
 * `persistEntry()`, e.g. written against 0.2.x): `expiresAt` folded into a
 * single `ttl` with the "earlier wins" rule — the remaining lifetime of the
 * earliest bound, at least 1 ms (a bound already past persists as "expired
 * now", never as "no expiry"). `{ ttl: 0 }` only when there is no bound.
 *
 * Call `persist()` immediately afterwards: the folded `ttl` is relative to
 * `now`, so any delay in between lengthens the lifetime by that delay.
 *
 * @throws TypeError for an invalid `expiresAt`
 */
export function foldToTtl(
    options: WfPersistOptions | undefined,
    now: number = Date.now(),
): WfPersistOptions | undefined {
    if (options?.expiresAt === undefined) return options;
    const at = resolveExpiresAt(options, undefined, now);
    return { ttl: at === undefined ? 0 : Math.max(1, at - now) };
}
