/**
 * Contract tests for state stores, strategies and mintWfStateToken.
 *
 * Property tests use a seeded PRNG so failures are reproducible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Workflow, createStep } from '../index';
import { outletEmail } from './helpers';
import { mintWfStateToken } from './mint';
import { EncapsulatedStateStrategy } from './state/encapsulated';
import { HandleStateStrategy, hashWfHandle } from './state/handle';
import type { HandleStateConfig } from './state/handle';
import { WfStateStoreMemory } from './state/memory';
import type { WfStateStore, WfStateStoreEntry } from './state/store';
import type { WfStateStrategy } from './state/strategy';
import {
    BackendTtlStore,
    keyMapped,
    peek,
    wrapMemory,
} from './state/test-stores';
import { foldToTtl, resolveExpiresAt } from './state/ttl';
import type { WfPersistOptions } from './state/ttl';
import type { WfState } from './types';

const NOW = 1_700_000_000_000;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const state = (n = 0): WfState => ({
    schemaId: 'flow',
    context: { n },
    indexes: [n],
});

afterEach(() => {
    vi.useRealTimers();
});

/** mulberry32 — tiny seeded PRNG. */
function prng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Yield to the event loop a random number of times (microtasks + macrotasks). */
async function jitter(rand: () => number) {
    const n = Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
        if (rand() < 0.5) await Promise.resolve();
        else await new Promise((r) => setImmediate(r));
    }
}

/**
 * Random latency before and after every operation of an atomic store, the
 * way a network round-trip does. Each operation stays atomic; the strategy's
 * composition of operations is what gets exercised.
 */
function laggy(inner: WfStateStoreMemory, rand: () => number): WfStateStore {
    const lag = async <R>(fn: () => Promise<R>): Promise<R> => {
        await jitter(rand);
        const r = await fn();
        await jitter(rand);
        return r;
    };
    return {
        set: (h, s, e) => lag(() => inner.set(h, s, e)),
        get: (h) => lag(() => inner.get(h)),
        delete: (h) => lag(() => inner.delete(h)),
        getAndDelete: (h) => lag(() => inner.getAndDelete(h)),
    };
}

/** A store that records every call as `op:key`. */
function recording() {
    const calls: string[] = [];
    const { inner, store } = wrapMemory((m) => ({
        set: (h, s, e) => (calls.push(`set:${h}`), m.set(h, s, e)),
        get: (h) => (calls.push(`get:${h}`), m.get(h)),
        delete: (h) => (calls.push(`delete:${h}`), m.delete(h)),
        getAndDelete: (h) => (
            calls.push(`getAndDelete:${h}`), m.getAndDelete(h)
        ),
    }));
    return { inner, store, calls };
}

/** A strategy written against 0.2.x: reads only `options.ttl`, no `*Entry()`. */
function ttlOnlyStrategy(store: WfStateStoreMemory): WfStateStrategy {
    let n = 0;
    return {
        async persist(st, o) {
            const id = `h${n++}`;
            const ttl = (o as { ttl?: number } | undefined)?.ttl ?? 0;
            await store.set(id, st, ttl > 0 ? Date.now() + ttl : undefined);
            return id;
        },
        async retrieve(t) {
            return (await store.get(t))?.state ?? null;
        },
        async consume(t) {
            return (await store.getAndDelete(t))?.state ?? null;
        },
    };
}

type AnyStrategy = HandleStateStrategy | EncapsulatedStateStrategy;
const strategyMakers: Array<[string, (defaultTtl?: number) => AnyStrategy]> = [
    [
        'HandleStateStrategy',
        (defaultTtl) =>
            new HandleStateStrategy({
                store: new WfStateStoreMemory(),
                defaultTtl,
            }),
    ],
    [
        'HandleStateStrategy (hashHandles)',
        (defaultTtl) =>
            new HandleStateStrategy({
                store: new WfStateStoreMemory(),
                defaultTtl,
                hashHandles: true,
            }),
    ],
    [
        'EncapsulatedStateStrategy',
        (defaultTtl) =>
            new EncapsulatedStateStrategy({
                secret: randomBytes(32),
                defaultTtl,
            }),
    ],
];

type HandleVariant = [string, Omit<HandleStateConfig, 'store'>];
const handleVariants: HandleVariant[] = [
    ['plain', {}],
    ['hashHandles: true', { hashHandles: true }],
    ['hashHandles + secret', { hashHandles: { secret: 'pepper' } }],
    ['hashHandles, no fallback', { hashHandles: { rawFallback: false } }],
];

/** Is the token alive exactly until `expiresAt` (`0` = forever)? */
async function expectLifetime(
    s: AnyStrategy,
    token: string,
    expiresAt: number,
) {
    if (expiresAt === 0) {
        vi.setSystemTime(NOW + 10 * 365 * 24 * 3600_000);
        expect(await s.retrieve(token)).not.toBeNull();
        return;
    }
    vi.setSystemTime(Math.floor(expiresAt));
    expect(await s.retrieve(token)).not.toBeNull();
    vi.setSystemTime(Math.floor(expiresAt) + 1);
    expect(await s.retrieve(token)).toBeNull();
}

// ---------------------------------------------------------------------------

describe('WfStateStoreMemory', () => {
    it.each([2, 3, 8, 64, 256])(
        'getAndDelete: %i parallel consumers → exactly one winner',
        async (n) => {
            const store = new WfStateStoreMemory();
            await store.set('k', state());
            const results = await Promise.all(
                Array.from({ length: n }, () => store.getAndDelete('k')),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await store.get('k')).toBeNull();
        },
    );

    it('getAndDelete: winner is unique across many keys consumed concurrently', async () => {
        const store = new WfStateStoreMemory();
        const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
        for (const k of keys) await store.set(k, state());
        const results = await Promise.all(
            keys.flatMap((k) =>
                Array.from({ length: 5 }, () =>
                    store.getAndDelete(k).then((r) => [k, r] as const),
                ),
            ),
        );
        for (const k of keys) {
            expect(results.filter(([key, r]) => key === k && r)).toHaveLength(
                1,
            );
        }
    });

    it('get is side-effect free: repeated and concurrent reads leave the entry', async () => {
        const store = new WfStateStoreMemory();
        await store.set('k', state(1), Date.now() + 60_000);
        await Promise.all(Array.from({ length: 20 }, () => store.get('k')));
        expect(await store.get('k')).toMatchObject({ state: state(1) });
        expect(await store.getAndDelete('k')).toMatchObject({
            state: state(1),
        });
    });

    it('expired entries are never returned', async () => {
        vi.useFakeTimers({ now: 1_000_000 });
        const store = new WfStateStoreMemory();
        await store.set('k', state(), Date.now() + 100);
        vi.setSystemTime(1_000_100);
        expect(await store.get('k')).not.toBeNull();
        vi.setSystemTime(1_000_101);
        expect(await store.get('k')).toBeNull();
        await store.set('k2', state(), Date.now() - 1);
        expect(await store.getAndDelete('k2')).toBeNull();
    });

    it('set overwrites the entry and its expiry', async () => {
        const store = new WfStateStoreMemory();
        await store.set('k', state(1), Date.now() - 1);
        await store.set('k', state(2));
        expect(await store.get('k')).toEqual({
            state: state(2),
            expiresAt: undefined,
        });
    });
});

// ---------------------------------------------------------------------------

describe('single-use consume', () => {
    describe.each(handleVariants)('HandleStateStrategy (%s)', (_label, cfg) => {
        it.each([2, 8, 64])(
            '%i parallel consume / consumeEntry of one token → exactly one winner',
            async (n) => {
                const s = new HandleStateStrategy({
                    ...cfg,
                    store: new WfStateStoreMemory(),
                });
                const token = await s.persist(state(), { ttl: 60_000 });
                const results = await Promise.all(
                    Array.from({ length: n }, (_, i) =>
                        i % 2 ? s.consumeEntry(token) : s.consume(token),
                    ),
                );
                expect(results.filter(Boolean)).toHaveLength(1);
                expect(await s.retrieve(token)).toBeNull();
            },
        );

        it('property: random latency + mixed retrieve/consume/consumeEntry → exactly one winner (200 seeds)', async () => {
            for (let seed = 1; seed <= 200; seed++) {
                const rand = prng(seed);
                const inner = new WfStateStoreMemory();
                const s = new HandleStateStrategy({
                    ...cfg,
                    store: laggy(inner, rand),
                });
                const token = await s.persist(state(seed));
                const n = 2 + Math.floor(rand() * 10);
                const ops = Array.from({ length: n }, (_, i) => {
                    const r = rand();
                    if (i > 0 && r < 0.3) {
                        return s.retrieve(token).then(() => null);
                    }
                    return r < 0.65 ? s.consume(token) : s.consumeEntry(token);
                });
                const results = await Promise.all(ops);
                expect(results.filter(Boolean), `seed ${seed}`).toHaveLength(1);
                expect(peek(inner).size, `seed ${seed}`).toBe(0);
            }
        });

        it('retrieve is side-effect free (store unchanged, token still consumable)', async () => {
            const inner = new WfStateStoreMemory();
            const s = new HandleStateStrategy({ ...cfg, store: inner });
            const token = await s.persist(state(7), { ttl: 60_000 });
            const before = peek(inner);
            for (let i = 0; i < 5; i++) {
                expect(await s.retrieve(token)).toEqual(state(7));
            }
            await Promise.all(
                Array.from({ length: 10 }, () => s.retrieve(token)),
            );
            expect(peek(inner)).toEqual(before);
            expect(await s.consume(token)).toEqual(state(7));
        });

        it('rejects an expired entry even if the store returns it', async () => {
            vi.useFakeTimers({ now: 5_000 });
            // A non-conforming store that ignores expiry.
            const { store } = wrapMemory((inner) => ({
                get: async (h) => peek(inner).get(h) ?? null,
                getAndDelete: async (h) => {
                    const e = peek(inner).get(h) ?? null;
                    await inner.delete(h);
                    return e;
                },
            }));
            const s = new HandleStateStrategy({ ...cfg, store });
            const token = await s.persist(state(), { ttl: 10 });
            vi.setSystemTime(5_011);
            expect(await s.retrieve(token)).toBeNull();
            expect(await s.consume(token)).toBeNull();
        });
    });

    it('EncapsulatedStateStrategy: retrieve/consume/consumeEntry are repeatable (stateless, documented)', async () => {
        vi.useFakeTimers({ now: NOW });
        const s = new EncapsulatedStateStrategy({ secret: randomBytes(32) });
        const token = await s.persist(state(3), { ttl: 700 });
        expect(await s.retrieve(token)).toEqual(state(3));
        expect(await s.consume(token)).toEqual(state(3));
        expect(await s.consumeEntry(token)).toEqual({
            state: state(3),
            expiresAt: NOW + 700,
        });
        expect(await s.retrieve(token)).toEqual(state(3));
    });
});

// ---------------------------------------------------------------------------

describe('expiry rules', () => {
    describe('resolveExpiresAt', () => {
        const now = 1_000;
        it.each([
            // [options, defaultTtl, expected absolute expiry]
            [undefined, undefined, undefined],
            [undefined, 50, 1_050],
            [{ ttl: 20 }, 50, 1_020],
            [{ ttl: 0 }, 50, undefined], // explicit 0 = never, not default
            [{ ttl: -1 }, 50, undefined],
            [{ ttl: NaN }, 50, undefined],
            [{ ttl: Infinity }, 50, undefined],
            [undefined, Infinity, undefined],
            [{ expiresAt: 5_000 }, 50, 5_000], // default not applied
            [{ expiresAt: 0 }, 50, undefined], // explicit never, default not applied
            [{ expiresAt: 500 }, 50, 500], // in the past: stays expired
            [{ ttl: 20, expiresAt: 5_000 }, 50, 1_020], // earlier wins
            [{ ttl: 9_000, expiresAt: 5_000 }, 50, 5_000], // earlier wins
            [{ ttl: 0, expiresAt: 5_000 }, 50, 5_000], // never loses to a bound
            [{ ttl: 20, expiresAt: 0 }, 50, 1_020],
            [{ ttl: undefined, expiresAt: 5_000 }, 50, 5_000],
        ] as Array<
            [
                WfPersistOptions | undefined,
                number | undefined,
                number | undefined,
            ]
        >)('options=%o defaultTtl=%s → %s', (options, defaultTtl, expected) => {
            expect(resolveExpiresAt(options, defaultTtl, now)).toBe(expected);
        });

        it.each([-1, NaN, Infinity, -Infinity])(
            'rejects expiresAt=%s',
            (expiresAt) => {
                expect(() => resolveExpiresAt({ expiresAt }, 50, now)).toThrow(
                    TypeError,
                );
            },
        );
    });

    it.each([
        // [options, folded]
        [{ ttl: 5, expiresAt: NOW + 9 }, { ttl: 5 }],
        [{ ttl: 50, expiresAt: NOW + 9 }, { ttl: 9 }],
        [{ expiresAt: NOW + 9 }, { ttl: 9 }],
        [{ expiresAt: NOW - 9 }, { ttl: 1 }], // past → "expired now", never "no expiry"
        [{ ttl: 0, expiresAt: NOW + 9 }, { ttl: 9 }],
        [{ expiresAt: 0 }, { ttl: 0 }],
        [{ ttl: 7 }, { ttl: 7 }],
        [undefined, undefined],
    ] as const)('foldToTtl(%o) → %o', (options, expected) => {
        expect(foldToTtl(options as WfPersistOptions | undefined, NOW)).toEqual(
            expected,
        );
    });

    const defaults: Array<number | undefined> = [
        undefined,
        0,
        -1,
        1,
        1000,
        1.5,
        NaN,
        Infinity,
    ];
    const options: Array<WfPersistOptions | undefined> = [
        undefined,
        {},
        { ttl: undefined },
        { ttl: 0 },
        { ttl: -5 },
        { ttl: 1 },
        { ttl: 500 },
        { ttl: 2.5 },
        { ttl: NaN },
        { ttl: Infinity },
        { expiresAt: NOW + 321 },
        { expiresAt: 0 },
        { ttl: 500, expiresAt: NOW + 321 },
    ];
    const combos = defaults.flatMap((d) => options.map((o) => [d, o] as const));

    describe.each(strategyMakers)('%s', (_label, make) => {
        it.each(combos)(
            'persistEntry(defaultTtl=%s, %o) reports exactly the expiry applied',
            async (defaultTtl, opts) => {
                vi.useFakeTimers({ now: NOW });
                const s = make(defaultTtl);
                const { token, expiresAt } = await s.persistEntry(
                    state(),
                    opts,
                );
                expect(expiresAt).toBe(
                    resolveExpiresAt(opts, defaultTtl, NOW) ?? 0,
                );
                await expectLifetime(s, token, expiresAt!);
            },
        );
    });

    it('HandleStateStrategy: the store receives the same expiry (undefined = never)', async () => {
        vi.useFakeTimers({ now: NOW });
        for (const [defaultTtl, opts] of combos) {
            const inner = new WfStateStoreMemory();
            const s = new HandleStateStrategy({ store: inner, defaultTtl });
            const { token, expiresAt } = await s.persistEntry(state(), opts);
            expect(peek(inner).get(token)!.expiresAt).toBe(
                expiresAt || undefined,
            );
        }
    });
});

// ---------------------------------------------------------------------------

describe('consumeEntry / persistEntry', () => {
    describe.each(strategyMakers)(
        '%s: exact-expiry restore',
        (_label, make) => {
            const originals: Array<WfPersistOptions | undefined> = [
                undefined,
                { ttl: 0 },
                { ttl: 60_000 },
                { ttl: 1 },
                { expiresAt: NOW + 12_345 },
                { expiresAt: 0 },
                { ttl: 60_000, expiresAt: NOW + 30_000 },
            ];
            const defaults: Array<number | undefined> = [undefined, 0, 5_000];
            const matrix = defaults.flatMap((d) =>
                originals.map((o) => [d, o] as const),
            );

            it.each(matrix)(
                'defaultTtl=%s persist(%o) → consumeEntry → persistEntry keeps the exact expiry',
                async (defaultTtl, original) => {
                    vi.useFakeTimers({ now: NOW });
                    const s = make(defaultTtl);
                    const token = await s.persist(state(1), original);
                    // 0 = never expires (known), a number = bound.
                    const expected =
                        resolveExpiresAt(original, defaultTtl, NOW) ?? 0;

                    vi.setSystemTime(NOW + 1); // time passes before the step runs
                    const entry = await s.consumeEntry(token);
                    expect(entry).toEqual({
                        state: state(1),
                        expiresAt: expected,
                    });

                    // Restore twice in a row: same expiry, default not re-applied.
                    const restored = await s.persistEntry(
                        entry!.state,
                        { expiresAt: entry!.expiresAt },
                        { handle: token },
                    );
                    expect(restored.expiresAt).toBe(expected);
                    const again = await s.consumeEntry(restored.token);
                    expect(again!.expiresAt).toBe(expected);
                    const final = await s.persistEntry(
                        again!.state,
                        { expiresAt: again!.expiresAt },
                        { handle: restored.token },
                    );
                    await expectLifetime(s, final.token, expected);
                },
            );

            it('an expired entry stays expired: restoring past its expiry yields a dead token', async () => {
                vi.useFakeTimers({ now: NOW });
                const s = make(5_000);
                const token = await s.persist(state(), { ttl: 100 });
                const entry = await s.consumeEntry(token);
                expect(entry!.expiresAt).toBe(NOW + 100);
                vi.setSystemTime(NOW + 101);
                const restored = await s.persist(
                    entry!.state,
                    { expiresAt: entry!.expiresAt },
                    { handle: token },
                );
                expect(await s.retrieve(restored)).toBeNull();
                expect(await s.consumeEntry(restored)).toBeNull();
                expect(await s.consume(restored)).toBeNull();
            });

            it('consumeEntry of an expired token is null', async () => {
                vi.useFakeTimers({ now: NOW });
                const s = make();
                const token = await s.persist(state(), { ttl: 10 });
                vi.setSystemTime(NOW + 11);
                expect(await s.consumeEntry(token)).toBeNull();
            });

            it('persist / persistEntry reject an invalid expiresAt (TypeError), with or without a ttl', async () => {
                const s = make(5_000);
                for (const expiresAt of [-1, NaN, Infinity, -Infinity]) {
                    for (const opts of [
                        { expiresAt },
                        { expiresAt, ttl: 10 },
                    ]) {
                        await expect(s.persist(state(), opts)).rejects.toThrow(
                            TypeError,
                        );
                        await expect(
                            s.persistEntry(state(), opts),
                        ).rejects.toThrow(TypeError);
                    }
                }
                // The strategy still works afterwards.
                const t = await s.persist(state(9));
                expect(await s.retrieve(t)).toEqual(state(9));
            });
        },
    );

    describe('HandleStateStrategy records the expiry, whatever the store returns', () => {
        const originals: Array<[string, WfPersistOptions | undefined, number]> =
            [
                ['ttl', { ttl: 60_000 }, NOW + 60_000],
                ['defaultTtl', undefined, NOW + 5_000],
                ['never', { ttl: 0 }, 0],
                ['absolute', { expiresAt: NOW + 777 }, NOW + 777],
            ];
        /** Persists only schemaId/context/indexes (drops `meta`); optionally echoes expiresAt. */
        const metaStripping = (echo: boolean) => () =>
            wrapMemory((inner) => {
                const strip = (e: WfStateStoreEntry | null) => {
                    if (!e) return null;
                    const { schemaId, context, indexes } = e.state;
                    const stripped = { schemaId, context, indexes };
                    return echo && e.expiresAt
                        ? { state: stripped, expiresAt: e.expiresAt }
                        : { state: stripped };
                };
                return {
                    get: async (h) => strip(await inner.get(h)),
                    getAndDelete: async (h) =>
                        strip(await inner.getAndDelete(h)),
                };
            }).store;
        const stores: Array<
            [string, () => WfStateStore, 'exact' | 'bound-only' | 'unknown']
        > = [
            ['memory', () => new WfStateStoreMemory(), 'exact'],
            ['backend TTL, no echo', () => new BackendTtlStore(), 'exact'],
            ['drops meta, echoes expiresAt', metaStripping(true), 'bound-only'],
            ['drops meta, no echo', metaStripping(false), 'unknown'],
        ];
        const matrix = stores.flatMap((st) =>
            originals.map((o) => [...st, ...o] as const),
        );

        it.each(matrix)(
            'store=%s persist=%s: expiresAt reported correctly (0 = never, undefined = unknown)',
            async (_s, makeStore, mode, _o, opts, applied) => {
                vi.useFakeTimers({ now: NOW });
                const s = new HandleStateStrategy({
                    store: makeStore(),
                    defaultTtl: 5_000,
                });
                const token = await s.persist(state(1), opts);
                const entry = await s.consumeEntry(token);
                expect(entry!.state).toEqual(state(1));
                const expected =
                    mode === 'exact'
                        ? applied
                        : mode === 'bound-only' && applied !== 0
                          ? applied
                          : undefined;
                expect(entry!.expiresAt).toBe(expected);
            },
        );

        it('restoring on a backend-TTL store keeps the backend TTL (the token does not become permanent)', async () => {
            vi.useFakeTimers({ now: NOW });
            const store = new BackendTtlStore();
            const s = new HandleStateStrategy({ store, defaultTtl: 60_000 });
            const token = await s.persist(state(3));
            const entry = await s.consumeEntry(token);
            expect(entry!.expiresAt).toBe(NOW + 60_000);
            await s.persistEntry(
                entry!.state,
                { expiresAt: entry!.expiresAt },
                { handle: token },
            );
            expect(store.data.get(token)!.px).toBe(NOW + 60_000);
            vi.setSystemTime(NOW + 60_001);
            expect(await s.retrieve(token)).toBeNull();
        });

        it('entries written by 0.2.x (no envelope) report unknown expiry unless the store returns a bound', async () => {
            const uuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
            const backend = new BackendTtlStore();
            await backend.set(uuid, state(1), Date.now() + 60_000);
            expect(
                await new HandleStateStrategy({ store: backend }).consumeEntry(
                    uuid,
                ),
            ).toEqual({ state: state(1), expiresAt: undefined });

            const mem = new WfStateStoreMemory();
            const exp = Date.now() + 60_000;
            await mem.set('h-bounded', state(2), exp);
            await mem.set('h-never', state(3));
            const s = new HandleStateStrategy({ store: mem });
            expect((await s.consumeEntry('h-bounded'))!.expiresAt).toBe(exp);
            expect(
                (await s.consumeEntry('h-never'))!.expiresAt,
            ).toBeUndefined();
        });

        it.each([undefined, {}, { a: 1 }])(
            'the envelope never leaks: meta=%o comes back exactly, the caller state is not mutated',
            async (meta) => {
                const s = new HandleStateStrategy({
                    store: new WfStateStoreMemory(),
                });
                const original: WfState =
                    meta === undefined ? state(1) : { ...state(1), meta };
                const snapshot = JSON.parse(JSON.stringify(original));
                const t = await s.persist(original, { ttl: 1000 });
                expect(original).toEqual(snapshot);
                expect(await s.retrieve(t)).toEqual(snapshot);
                expect((await s.consumeEntry(t))!.state).toEqual(snapshot);
            },
        );

        it('a caller-supplied __wfExpiry cannot forge the expiry', async () => {
            vi.useFakeTimers({ now: NOW });
            const s = new HandleStateStrategy({
                store: new BackendTtlStore(),
                defaultTtl: 1000,
            });
            const t = await s.persist({
                ...state(1),
                meta: { __wfExpiry: { at: 0 }, x: 1 },
            });
            expect(await s.consumeEntry(t)).toEqual({
                state: { ...state(1), meta: { x: 1 } },
                expiresAt: NOW + 1000,
            });
        });

        it('rejects an entry whose envelope says expired, even if the store ignores expiry', async () => {
            vi.useFakeTimers({ now: NOW });
            const store = new BackendTtlStore();
            const s = new HandleStateStrategy({ store });
            const t = await s.persist(state(), { ttl: 10 });
            store.data.get(t)!.px = undefined; // backend lost the TTL
            vi.setSystemTime(NOW + 11);
            expect(await s.retrieve(t)).toBeNull();
            expect(await s.consumeEntry(t)).toBeNull();
        });
    });

    describe('override bridge: *Entry() never bypasses an overridden consume()/persist()', () => {
        const calls: string[] = [];
        const blocked = new Set<string>();
        const persisted: Array<WfPersistOptions | undefined> = [];
        class AuditedHandle extends HandleStateStrategy {
            async consume(t: string) {
                calls.push(t);
                return blocked.has(t) ? null : super.consume(t);
            }
            async persist(
                st: WfState,
                o?: WfPersistOptions,
                ov?: { handle?: string },
            ) {
                persisted.push(o);
                return super.persist(st, o, ov);
            }
        }
        class AuditedEncapsulated extends EncapsulatedStateStrategy {
            async consume(t: string) {
                calls.push(t);
                return blocked.has(t) ? null : super.consume(t);
            }
            async persist(
                st: WfState,
                o?: WfPersistOptions,
                ov?: { handle?: string },
            ) {
                persisted.push(o);
                return super.persist(st, o, ov);
            }
        }
        const makers: Array<[string, () => AnyStrategy]> = [
            [
                'HandleStateStrategy',
                () => new AuditedHandle({ store: new WfStateStoreMemory() }),
            ],
            [
                'EncapsulatedStateStrategy',
                () => new AuditedEncapsulated({ secret: randomBytes(32) }),
            ],
        ];

        it.each(makers)(
            '%s: consumeEntry delegates to consume() and reports unknown expiry',
            async (_label, make) => {
                calls.length = 0;
                const s = make();
                const t1 = await s.persist(state(1), { ttl: 1000 });
                blocked.add(t1);
                expect(await s.consumeEntry(t1)).toBeNull();
                const t2 = await s.persist(state(2), { ttl: 1000 });
                expect(await s.consumeEntry(t2)).toEqual({
                    state: state(2),
                    expiresAt: undefined,
                });
                expect(calls).toEqual([t1, t2]);
            },
        );

        it.each(makers)(
            '%s: persistEntry delegates to persist() with expiresAt folded into ttl; expiry unknown',
            async (_label, make) => {
                vi.useFakeTimers({ now: NOW });
                persisted.length = 0;
                const s = make();
                const r = await s.persistEntry(state(4), {
                    ttl: 900,
                    expiresAt: NOW + 400,
                });
                expect(r).toEqual({
                    token: expect.any(String),
                    expiresAt: undefined,
                });
                expect(persisted).toEqual([{ ttl: 400 }]);
                await expectLifetime(s, r.token, NOW + 400);
            },
        );
    });
});

// ---------------------------------------------------------------------------

/** Spellings a store with a non-exact comparison may treat as `key`. */
function keyVariants(key: string): string[] {
    const rest = key.slice(5);
    const prefix = key.slice(0, 5);
    const fullwidth = [...prefix]
        .map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
        .join('');
    return [
        key,
        key.toUpperCase(),
        key.toLowerCase(),
        prefix.toUpperCase() + rest,
        prefix[0].toUpperCase() + prefix.slice(1) + rest,
        key + ' ',
        ' ' + key,
        key + '\t',
        key + ' ',
        fullwidth + rest, // NFKC → the same key
    ];
}

describe('hashHandles', () => {
    it('off by default: the store key is the raw handle, a UUID', async () => {
        const store = new WfStateStoreMemory();
        const s = new HandleStateStrategy({ store });
        const token = await s.persist(state());
        expect(token).toMatch(UUID_RE);
        expect([...peek(store).keys()]).toEqual([token]);
    });

    it.each([
        ['true', true, undefined],
        ['secret string', { secret: 'pepper' }, 'pepper'],
        ['secret buffer', { secret: Buffer.from('k') }, Buffer.from('k')],
    ] as const)(
        'hashHandles %s: the raw handle never reaches the store',
        async (_label, hashHandles, secret) => {
            const { inner, store, calls } = recording();
            const s = new HandleStateStrategy({
                store,
                hashHandles: hashHandles as HandleStateConfig['hashHandles'],
            });
            const tokens: string[] = [];
            for (let i = 0; i < 20; i++) {
                const t = await s.persist(state(i));
                tokens.push(t);
                await s.retrieve(t);
                if (i % 2) await s.consume(t);
            }
            const seen = calls.join('\n') + JSON.stringify([...peek(inner)]);
            for (const t of tokens) expect(seen).not.toContain(t);
            for (const k of peek(inner).keys()) {
                expect(k).toMatch(
                    secret === undefined
                        ? /^wfh1_[A-Za-z0-9_-]{43}$/
                        : /^wfk1_[A-Za-z0-9_-]{43}$/,
                );
            }
            expect([...peek(inner).keys()]).toContain(
                hashWfHandle(tokens[0], secret),
            );
        },
    );

    describe('new handles skip the raw-key fallback', () => {
        it('default handles with hashing are 22 base64url chars, never UUID- or wf[hk]-shaped', async () => {
            const s = new HandleStateStrategy({
                store: new WfStateStoreMemory(),
                hashHandles: true,
            });
            for (let i = 0; i < 500; i++) {
                const t = await s.persist(state());
                expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
                expect(t).not.toMatch(UUID_RE);
                expect(t).not.toMatch(/wf[hk]/i);
            }
        });

        it('a new-shaped token costs one store call on a miss, and re-persisting it never touches a raw key', async () => {
            const { store, calls } = recording();
            const s = new HandleStateStrategy({ store, hashHandles: true });
            const t = await s.persist(state());
            await s.consume(t);
            calls.length = 0;
            expect(await s.retrieve(t)).toBeNull();
            expect(await s.consume(t)).toBeNull();
            expect(calls).toEqual([
                `get:${hashWfHandle(t)}`,
                `getAndDelete:${hashWfHandle(t)}`,
            ]);
            calls.length = 0;
            await s.persist(state(1), undefined, { handle: t });
            expect(calls).toEqual([`set:${hashWfHandle(t)}`]);
        });

        it('an old UUID token still takes the fallback (second lookup on a miss)', async () => {
            const { store, calls } = recording();
            const s = new HandleStateStrategy({ store, hashHandles: true });
            const uuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
            expect(await s.consume(uuid)).toBeNull();
            expect(calls).toEqual([
                `getAndDelete:${hashWfHandle(uuid)}`,
                `getAndDelete:${uuid}`,
            ]);
        });
    });

    describe('secret', () => {
        it('SHA-256 and HMAC keyspaces do not mix', async () => {
            const store = new WfStateStoreMemory();
            const sha = new HandleStateStrategy({ store, hashHandles: true });
            const hmac = new HandleStateStrategy({
                store,
                hashHandles: { secret: 'a', rawFallback: false },
            });
            const other = new HandleStateStrategy({
                store,
                hashHandles: { secret: 'b', rawFallback: false },
            });
            const t = await hmac.persist(state());
            expect(await other.retrieve(t)).toBeNull();
            expect(await sha.retrieve(t)).toBeNull();
            expect(await hmac.consume(t)).toEqual(state());
        });

        it.each([
            ['undefined', undefined],
            ['empty string', ''],
            ['empty buffer', Buffer.alloc(0)],
        ])('a present-but-%s secret throws', (_label, secret) => {
            expect(
                () =>
                    new HandleStateStrategy({
                        store: new WfStateStoreMemory(),
                        hashHandles: { secret },
                    }),
            ).toThrow(/secret/);
        });

        it('hashWfHandle: wfh1_ for SHA-256, wfk1_ for HMAC; an empty secret throws', () => {
            expect(hashWfHandle('x')).toMatch(/^wfh1_[A-Za-z0-9_-]{43}$/);
            expect(hashWfHandle('x', 'k')).toMatch(/^wfk1_[A-Za-z0-9_-]{43}$/);
            expect(() => hashWfHandle('x', '')).toThrow(/secret/);
        });

        it('omitting the secret property is plain SHA-256', async () => {
            const store = new WfStateStoreMemory();
            const s = new HandleStateStrategy({ store, hashHandles: {} });
            const t = await s.persist(state());
            expect([...peek(store).keys()]).toEqual([hashWfHandle(t)]);
        });
    });

    describe('a leaked hashed key is never usable as a token', () => {
        const hexHandle = () => randomBytes(16).toString('hex');
        const configs: Array<[string, Omit<HandleStateConfig, 'store'>]> = [
            ['hashHandles: true', { hashHandles: true }],
            ['hashHandles + secret', { hashHandles: { secret: 's' } }],
            ['no fallback', { hashHandles: { rawFallback: false } }],
            [
                'custom handles, no legacyHandle (fallback off)',
                { generateHandle: hexHandle, hashHandles: true },
            ],
            [
                'custom handles, permissive legacyHandle',
                {
                    generateHandle: hexHandle,
                    hashHandles: { legacyHandle: () => true },
                },
            ],
        ];
        const stores: Array<
            [string, () => { inner: WfStateStoreMemory; store: WfStateStore }]
        > = [
            ['exact (memory)', () => wrapMemory()],
            [
                'collating (ci + trim + NFKC)',
                () =>
                    keyMapped((k) => k.normalize('NFKC').trim().toLowerCase()),
            ],
        ];

        describe.each(stores)('store: %s', (_storeLabel, makeStore) => {
            it.each(configs)(
                '%s: property over 20 tokens × 10 spellings',
                async (_label, cfg) => {
                    const { inner, store } = makeStore();
                    const s = new HandleStateStrategy({ ...cfg, store });
                    const secret =
                        typeof cfg.hashHandles === 'object'
                            ? cfg.hashHandles.secret
                            : undefined;
                    const tokens: string[] = [];
                    for (let i = 0; i < 20; i++) {
                        tokens.push(await s.persist(state(i)));
                    }
                    const before = peek(inner);
                    for (const t of tokens) {
                        for (const forged of keyVariants(
                            hashWfHandle(t, secret),
                        )) {
                            expect(await s.retrieve(forged), forged).toBeNull();
                            expect(await s.consume(forged), forged).toBeNull();
                            expect(
                                await s.consumeEntry(forged),
                                forged,
                            ).toBeNull();
                        }
                    }
                    expect(peek(inner)).toEqual(before);
                    // Legit tokens still work, exactly once.
                    for (const [i, t] of tokens.entries()) {
                        expect(await s.consume(t)).toEqual(state(i));
                        expect(await s.consume(t)).toBeNull();
                    }
                },
            );
        });

        it('accent-insensitive store + lax legacyHandle: accented spellings are refused', async () => {
            // utf8mb4_0900_ai_ci-like: strip diacritics, lowercase, PAD SPACE.
            const { inner, store } = keyMapped((k) =>
                k
                    .normalize('NFD')
                    .replace(/[̀-ͯ]/g, '')
                    .toLowerCase()
                    .replace(/ +$/, ''),
            );
            const s = new HandleStateStrategy({
                store,
                generateHandle: () => randomBytes(16).toString('base64url'),
                hashHandles: { legacyHandle: (t) => t.length >= 20 },
            });
            const t = await s.persist(state(9));
            const leaked = [...peek(inner).keys()][0];
            for (const a of ['ẃ', 'ŵ', 'ẁ', 'ẅ', 'ẘ']) {
                const forged = a + leaked.slice(1);
                expect(await s.retrieve(forged), forged).toBeNull();
                expect(await s.consume(forged), forged).toBeNull();
            }
            // Accents anywhere, not only on the prefix.
            const mid = leaked.slice(0, 10) + 'é' + leaked.slice(11);
            expect(await s.consume(mid)).toBeNull();
            expect(await s.consume(t)).toEqual(state(9));
        });
    });

    describe('raw-key fallback (0.3.x upgrade aid)', () => {
        async function legacyHandle(store: WfStateStore, n = 0) {
            // Issued before the upgrade: stored under the raw handle.
            return new HandleStateStrategy({ store }).persist(state(n));
        }

        it('pre-upgrade handles still retrieve and consume once', async () => {
            const store = new WfStateStoreMemory();
            const token = await legacyHandle(store, 4);
            const s = new HandleStateStrategy({ store, hashHandles: true });
            expect(await s.retrieve(token)).toEqual(state(4));
            const results = await Promise.all(
                Array.from({ length: 16 }, (_, i) =>
                    i % 2 ? s.consumeEntry(token) : s.consume(token),
                ),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(peek(store).size).toBe(0);
        });

        it.each(handleVariants)(
            '%s: consumeEntry reports the expiry of a pre-upgrade entry (when the fallback applies)',
            async (_label, cfg) => {
                vi.useFakeTimers({ now: NOW });
                const store = new WfStateStoreMemory();
                const token = await new HandleStateStrategy({ store }).persist(
                    state(),
                    { ttl: 1_000 },
                );
                const entry = await new HandleStateStrategy({
                    ...cfg,
                    store,
                }).consumeEntry(token);
                const fallsBack = !(
                    typeof cfg.hashHandles === 'object' &&
                    cfg.hashHandles.rawFallback === false
                );
                expect(entry).toEqual(
                    fallsBack
                        ? { state: state(), expiresAt: NOW + 1_000 }
                        : null,
                );
            },
        );

        it('re-persisting a pre-upgrade handle moves it to the hashed key (never both)', async () => {
            const store = new WfStateStoreMemory();
            const token = await legacyHandle(store, 1);
            const s = new HandleStateStrategy({ store, hashHandles: true });
            await s.persist(state(2), undefined, { handle: token });
            expect([...peek(store).keys()]).toEqual([hashWfHandle(token)]);
            expect(await s.consume(token)).toEqual(state(2));
            expect(await s.consume(token)).toBeNull();
        });

        it('property: concurrent consumes + one re-persist of a pre-upgrade handle — each persisted version is consumed at most once (300 seeds)', async () => {
            for (let seed = 1; seed <= 300; seed++) {
                const rand = prng(seed);
                const inner = new WfStateStoreMemory();
                const token = await legacyHandle(inner, 1);
                const s = new HandleStateStrategy({
                    store: laggy(inner, rand),
                    hashHandles: true,
                });
                const n = 2 + Math.floor(rand() * 8);
                const at = Math.floor(rand() * (n + 1));
                const ops: Array<Promise<WfState | null | 'persisted'>> = [];
                for (let i = 0; i <= n; i++) {
                    ops.push(
                        i === at
                            ? s
                                  .persist(state(2), undefined, {
                                      handle: token,
                                  })
                                  .then(() => 'persisted' as const)
                            : s.consume(token),
                    );
                }
                const results = await Promise.all(ops);
                const version = (v: number) =>
                    results.filter(
                        (r) => r && r !== 'persisted' && r.indexes[0] === v,
                    ).length;
                expect(version(1), `seed ${seed}`).toBeLessThanOrEqual(1);
                expect(version(2), `seed ${seed}`).toBeLessThanOrEqual(1);
                // Nothing is left under the raw key; v2 is either consumed
                // or still waiting under its hash.
                const keys = [...peek(inner).keys()];
                expect(keys, `seed ${seed}`).not.toContain(token);
                expect(keys.length, `seed ${seed}`).toBe(version(2) ? 0 : 1);
            }
        });

        it('rawFallback: false ignores pre-upgrade handles', async () => {
            const store = new WfStateStoreMemory();
            const token = await legacyHandle(store);
            const s = new HandleStateStrategy({
                store,
                hashHandles: { rawFallback: false },
            });
            expect(await s.retrieve(token)).toBeNull();
            expect(await s.consume(token)).toBeNull();
        });

        it('default handles: only strict lowercase v4 UUIDs fall back', async () => {
            const store = new WfStateStoreMemory();
            const s = new HandleStateStrategy({ store, hashHandles: true });
            const upper = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';
            const notUuid = 'legacy-handle';
            const uuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
            for (const k of [upper, notUuid, uuid, uuid + ' ']) {
                await store.set(k, state(1));
            }
            expect(await s.retrieve(upper)).toBeNull();
            expect(await s.retrieve(notUuid)).toBeNull();
            expect(await s.retrieve(uuid + ' ')).toBeNull();
            expect(await s.consume(uuid)).toEqual(state(1));
        });

        it('custom handles: the fallback needs legacyHandle (fails closed without one)', async () => {
            const store = new WfStateStoreMemory();
            await store.set('custom-1', state(1));
            await store.set('custom-2', state(2));
            const off = new HandleStateStrategy({
                store,
                generateHandle: () => 'x',
                hashHandles: true,
            });
            expect(await off.retrieve('custom-1')).toBeNull();
            const on = new HandleStateStrategy({
                store,
                generateHandle: () => 'x',
                hashHandles: { legacyHandle: (t) => /^custom-\d+$/.test(t) },
            });
            expect(await on.consume('custom-1')).toEqual(state(1));
            expect(await on.retrieve('custom-2 ')).toBeNull();
            expect(await on.retrieve('ｃustom-2')).toBeNull();
            expect(
                () =>
                    new HandleStateStrategy({
                        store,
                        generateHandle: () => 'x',
                        hashHandles: { rawFallback: true },
                    }),
            ).toThrow(/legacyHandle/);
        });

        it('legacyHandle is only called with printable ASCII tokens free of wf[hk]', async () => {
            const seen: string[] = [];
            const s = new HandleStateStrategy({
                store: new WfStateStoreMemory(),
                generateHandle: () => 'x',
                hashHandles: {
                    legacyHandle: (t) => {
                        seen.push(t);
                        return true;
                    },
                },
            });
            for (const t of [
                'abc',
                'ab c',
                'abé',
                'ab\t',
                'аbc',
                'xWfHx',
                'ok-1',
            ]) {
                await s.retrieve(t);
            }
            expect(seen).toEqual(['abc', 'ok-1']);
        });
    });
});

// ---------------------------------------------------------------------------

type InviteCtx = { email: string; accepted?: boolean };

function inviteWorkflow(expires?: number) {
    const wf = new Workflow<InviteCtx, unknown>([
        createStep<InviteCtx, { ok: boolean } | undefined>('accept', {
            handler: (ctx, input) => {
                if (!input) {
                    const out = outletEmail(ctx.email, 'invite');
                    return expires === undefined ? out : { ...out, expires };
                }
                ctx.accepted = input.ok;
            },
        }),
    ]);
    wf.register('invite', ['accept']);
    wf.register('noop', []);
    return wf;
}

describe('mintWfStateToken', () => {
    it('starts the flow headless, persists the pause, returns a resumable single-use token', async () => {
        const store = new WfStateStoreMemory();
        const strategy = new HandleStateStrategy({ store, hashHandles: true });
        const wf = inviteWorkflow();
        const minted = await mintWfStateToken(wf, {
            strategy,
            schemaId: 'invite',
            context: { email: 'a@example.com' },
        });
        expect(minted.token).toEqual(expect.any(String));
        expect(minted.inputRequired).toMatchObject({
            outlet: 'email',
            target: 'a@example.com',
        });
        // Token is raw; the store only holds its hash.
        expect([...peek(store).keys()]).toEqual([hashWfHandle(minted.token!)]);
        const st = await strategy.consume(minted.token!);
        expect(st).not.toBeNull();
        expect(await strategy.consume(minted.token!)).toBeNull();
        const out = await wf.resume(st as never, { ok: true });
        expect(out.finished).toBe(true);
        expect((out.state.context as InviteCtx).accepted).toBe(true);
    });

    it('a flow that does not pause yields no token and persists nothing', async () => {
        const store = new WfStateStoreMemory();
        const minted = await mintWfStateToken(inviteWorkflow(), {
            strategy: new HandleStateStrategy({ store }),
            schemaId: 'noop',
            context: { email: 'x' },
        });
        expect(minted.token).toBeUndefined();
        expect(minted.output.finished).toBe(true);
        expect(peek(store).size).toBe(0);
    });

    it.each([
        // [options.ttl, step expires offset, defaultTtl, expected expiry offset (null = never)]
        [undefined, undefined, undefined, null],
        [undefined, undefined, 1000, 1000],
        [undefined, 5000, 1000, 5000], // step expires: default not applied
        [200, 5000, 1000, 200], // earliest wins
        [9000, 5000, 1000, 5000], // ttl cannot extend the step's bound
        [0, 5000, 1000, 5000], // ttl 0 = never, loses to the step's bound
        [0, undefined, 1000, null], // explicit 0 = never
        [undefined, -10, 1000, -10], // already past → stored expired
    ] as const)(
        'persistEntry strategy: ttl=%s, step expires=+%s, defaultTtl=%s → %s',
        async (ttl, expiresIn, defaultTtl, expected) => {
            vi.useFakeTimers({ now: NOW });
            const store = new WfStateStoreMemory();
            const strategy = new HandleStateStrategy({ store, defaultTtl });
            const minted = await mintWfStateToken(
                inviteWorkflow(
                    expiresIn === undefined ? undefined : NOW + expiresIn,
                ),
                { strategy, schemaId: 'invite', context: { email: 'x' }, ttl },
            );
            expect(minted.expiresAt).toBe(
                expected === null ? 0 : NOW + expected,
            );
            expect(peek(store).get(minted.token!)!.expiresAt).toBe(
                expected === null ? undefined : NOW + expected,
            );
        },
    );

    it.each([
        // [ttl option, step expires offset, expected stored offset (null = never)]
        [undefined, 5_000, 5_000],
        [200, 5_000, 200],
        [9_000, 5_000, 5_000],
        [0, 5_000, 5_000],
        [undefined, -10, 1], // past → "expired now" (1 ms), never "no expiry"
        [300, undefined, 300],
        [0, undefined, null],
    ] as const)(
        'ttl-only strategy (no persistEntry): ttl=%s, step expires=+%s → stored bound +%s, expiry unknown',
        async (ttl, expiresIn, expected) => {
            vi.useFakeTimers({ now: NOW });
            const store = new WfStateStoreMemory();
            const m = await mintWfStateToken(
                inviteWorkflow(
                    expiresIn === undefined ? undefined : NOW + expiresIn,
                ),
                {
                    strategy: ttlOnlyStrategy(store),
                    schemaId: 'invite',
                    context: { email: 'x' },
                    ttl,
                },
            );
            expect(peek(store).get(m.token!)!.expiresAt).toBe(
                expected === null ? undefined : NOW + expected,
            );
            expect(m.expiresAt).toBeUndefined();
        },
    );

    it.each([-1, NaN, Infinity, -Infinity])(
        'rejects ttl=%s with a TypeError before running the flow',
        async (ttl) => {
            const store = new WfStateStoreMemory();
            const start = vi.fn();
            await expect(
                mintWfStateToken({ start } as never, {
                    strategy: new HandleStateStrategy({ store }),
                    schemaId: 'invite',
                    context: { email: 'x' },
                    ttl,
                }),
            ).rejects.toThrow(TypeError);
            expect(start).not.toHaveBeenCalled();
            expect(peek(store).size).toBe(0);
        },
    );

    it.each([
        ['the flow', 'flow'],
        ['the meta function', 'meta'],
        ['the strategy picker', 'pick'],
        ['an invalid step expires', 'expires'],
    ] as const)(
        '%s throwing persists nothing and rethrows',
        async (_label, what) => {
            const store = new WfStateStoreMemory();
            const strategy = new HandleStateStrategy({ store });
            const boom = new Error(`boom-${what}`);
            const thrower = (): never => {
                throw boom;
            };
            let wf = inviteWorkflow(what === 'expires' ? -5 : undefined);
            if (what === 'flow') {
                wf = new Workflow<InviteCtx, unknown>([
                    createStep<InviteCtx>('boom', { handler: thrower }),
                ]);
                wf.register('invite', ['boom']);
            }
            const run = mintWfStateToken(wf, {
                strategy: what === 'pick' ? thrower : strategy,
                schemaId: 'invite',
                context: { email: 'x' },
                meta: what === 'meta' ? thrower : undefined,
            });
            if (what === 'expires') {
                await expect(run).rejects.toThrow(TypeError);
            } else {
                await expect(run).rejects.toBe(boom);
            }
            expect(peek(store).size).toBe(0);
        },
    );

    it('meta (object or function) is merged into state.meta; strategy may be chosen from the pause', async () => {
        const a = new HandleStateStrategy({ store: new WfStateStoreMemory() });
        const b = new HandleStateStrategy({
            store: new WfStateStoreMemory(),
            defaultTtl: 77,
        });
        const pick = vi.fn(() => b);
        const minted = await mintWfStateToken(inviteWorkflow(), {
            strategy: pick,
            schemaId: 'invite',
            context: { email: 'x' },
            meta: ({ inputRequired, output }) => ({
                finished: output.finished,
                outlet: (inputRequired as { outlet: string }).outlet,
            }),
        });
        expect(pick).toHaveBeenCalledWith(
            expect.objectContaining({ outlet: 'email' }),
        );
        expect(await a.retrieve(minted.token!)).toBeNull();
        expect((await b.retrieve(minted.token!))!.meta).toEqual({
            finished: false,
            outlet: 'email',
        });

        const m2 = await mintWfStateToken(inviteWorkflow(), {
            strategy: a,
            schemaId: 'invite',
            context: { email: 'x' },
            meta: { source: 'admin' },
        });
        expect((await a.retrieve(m2.token!))!.meta).toEqual({
            source: 'admin',
        });
    });
});
