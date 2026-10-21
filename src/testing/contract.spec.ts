import { describe, expect, it } from 'vitest';
import { WfStateStoreMemory } from '../outlets/state/memory';
import type { WfStateStore } from '../outlets/state/store';
import {
    BackendTtlStore,
    keyMapped,
    peek,
    wrapMemory,
} from '../outlets/state/test-stores';
import type { WfState } from '../outlets/types';
import { checkWfStateStoreContract } from './index';

/** Short expiry probe for in-memory stores, to keep the suite fast. */
const FAST = { expiryProbeMs: 200 };

const variant =
    (over: Parameters<typeof wrapMemory>[0]): (() => WfStateStore) =>
    () =>
        wrapMemory(over).store;

describe('checkWfStateStoreContract', () => {
    it.each([
        ['WfStateStoreMemory', () => new WfStateStoreMemory()],
        [
            'a backend-TTL store that does not echo expiresAt',
            () => new BackendTtlStore(),
        ],
    ])('%s meets the contract', async (_label, make) => {
        expect(await checkWfStateStoreContract(make, FAST)).toEqual([]);
    });

    it('accepts a store that reorders object keys (jsonb)', async () => {
        const sortKeys = (v: unknown): unknown =>
            Array.isArray(v)
                ? v.map(sortKeys)
                : v && typeof v === 'object'
                  ? Object.fromEntries(
                        Object.keys(v)
                            .sort(
                                (a, b) =>
                                    a.length - b.length || (a < b ? -1 : 1),
                            )
                            .map((k) => [
                                k,
                                sortKeys((v as Record<string, unknown>)[k]),
                            ]),
                    )
                  : v;
        const make = variant((inner) => ({
            set: (h, s, e) =>
                inner.set(
                    h,
                    sortKeys(JSON.parse(JSON.stringify(s))) as WfState,
                    e,
                ),
        }));
        expect(await checkWfStateStoreContract(make, FAST)).toEqual([]);
    });

    it(
        'a slow but compliant store (80 ms per call) passes with the defaults',
        { timeout: 30_000 },
        async () => {
            const delay = () => new Promise((r) => setTimeout(r, 80));
            const make = variant((inner) => ({
                set: async (h, s, e) => {
                    await delay();
                    await inner.set(h, s, e);
                },
                get: async (h) => {
                    await delay();
                    return inner.get(h);
                },
                delete: async (h) => {
                    await delay();
                    await inner.delete(h);
                },
                getAndDelete: async (h) => {
                    await delay();
                    return inner.getAndDelete(h);
                },
            }));
            expect(await checkWfStateStoreContract(make)).toEqual([]);
        },
    );

    it.each([
        [
            'non-atomic getAndDelete (read, await, delete)',
            /getAndDelete/,
            variant((inner) => ({
                getAndDelete: async (h) => {
                    const e = await inner.get(h);
                    await Promise.resolve();
                    if (e) await inner.delete(h);
                    return e;
                },
            })),
        ],
        [
            'case-insensitive keys (MySQL *_ci)',
            /exact/,
            () => keyMapped((k) => k.toLowerCase()).store,
        ],
        [
            'trailing spaces ignored (PAD SPACE)',
            /exact/,
            () => keyMapped((k) => k.replace(/ +$/, '')).store,
        ],
        [
            'expired entries returned',
            /expir/,
            variant((inner) => ({
                get: async (h) => peek(inner).get(h) ?? null,
                getAndDelete: async (h) => {
                    const e = peek(inner).get(h) ?? null;
                    await inner.delete(h);
                    return e;
                },
            })),
        ],
        [
            'get deletes',
            /side-effect/,
            variant((inner) => ({ get: (h) => inner.getAndDelete(h) })),
        ],
        [
            'get slides the TTL (no expiresAt echo)',
            /side-effect/,
            () =>
                new BackendTtlStore((row) => {
                    if (row.px) row.px = Date.now() + 3600_000;
                }),
        ],
        [
            'get slides the TTL by the original lifetime',
            /extended/,
            () =>
                new BackendTtlStore((row) => {
                    if (row.life) row.px = Date.now() + row.life;
                }),
        ],
        [
            'get slides an echoed expiresAt',
            /side-effect/,
            variant((inner) => ({
                get: async (h) => {
                    const e = await inner.get(h);
                    if (!e?.expiresAt) return e;
                    await inner.set(h, e.state, e.expiresAt + 60_000);
                    return inner.get(h);
                },
            })),
        ],
        [
            'wrong expiresAt echoed',
            /expiresAt/,
            variant((inner) => ({
                get: async (h) => {
                    const e = await inner.get(h);
                    return (
                        e && {
                            state: e.state,
                            expiresAt: (e.expiresAt ?? 0) + 1000,
                        }
                    );
                },
            })),
        ],
        [
            'meta dropped',
            /round-trip/,
            variant((inner) => ({
                get: async (h) => {
                    const e = await inner.get(h);
                    if (!e) return null;
                    const { meta: _m, ...state } = e.state;
                    return { state };
                },
            })),
        ],
        [
            'set does not overwrite',
            /overwrite/,
            variant((inner) => ({
                set: async (h, s, e) => {
                    if (!(await inner.get(h))) await inner.set(h, s, e);
                },
            })),
        ],
    ] as const)('flags a store whose %s', async (_label, rule, make) => {
        const violations = await checkWfStateStoreContract(make, FAST);
        expect(violations.join('\n')).toMatch(rule);
    });

    it('uses 48-character keys and cleans up even when a check throws', async () => {
        const keys = new Set<string>();
        let calls = 0;
        const { inner, store } = wrapMemory((m) => ({
            set: (h, s, e) => (keys.add(h), m.set(h, s, e)),
            get: async (h) => {
                if (++calls % 3 === 0) throw new Error('flaky');
                return m.get(h);
            },
        }));
        const v = await checkWfStateStoreContract(() => store, FAST);
        expect(v.some((x) => /threw flaky/.test(x))).toBe(true);
        for (const k of keys) expect(k).toHaveLength(48);
        expect(peek(inner).size).toBe(0);
    });
});
