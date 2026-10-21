import { randomBytes } from 'node:crypto';
import type { WfStateStore } from '../outlets/state/store';
import type { WfState } from '../outlets/types';

export interface WfStoreContractOptions {
    /** Parallel `getAndDelete` calls per atomicity round. Default `[2, 8, 32]`. */
    concurrency?: number[];
    /**
     * Minimum lifetime (ms) of the short-lived entry used to check expiry and
     * detect a `get()` that extends it; the check takes a little longer than
     * this. It is raised automatically to 10× the measured store round trip.
     * Default `1000`. Raise it for stores with coarse expiry resolution (e.g.
     * second-granularity TTLs) or clock skew between app and database.
     */
    expiryProbeMs?: number;
}

/**
 * Check a `WfStateStore` implementation against the `WfStateStore` contract:
 * atomic `getAndDelete`, side-effect-free `get` (including not extending the
 * expiry), expiry honoured, `set` overwrites, `delete`, exact key comparison,
 * `expiresAt` echoed exactly or not at all, and the state round-tripping
 * including `meta` (object key order is ignored, so jsonb-style stores pass).
 *
 * Framework-agnostic: returns the list of violations (empty = conforms).
 * Probe keys look like real hashed keys (48 characters) and are fresh and
 * random; every check deletes its keys in a `finally`, so it can run against
 * a shared test database.
 *
 * Limits: the atomicity check fires concurrent calls from THIS process only.
 * It catches read-then-delete races in your code, but cannot prove atomicity
 * across processes or replicas — that has to come from the backend operation
 * you use (see the `WfStateStore` contract). The expiry probe waits about
 * `expiryProbeMs` (or 10× the store round trip, whichever is larger) of real
 * time, so run it with real timers.
 *
 * @example
 * it('MyStore meets the WfStateStore contract', async () => {
 *     expect(await checkWfStateStoreContract(() => new MyStore(db))).toEqual([]);
 * });
 */
export async function checkWfStateStoreContract(
    makeStore: () => WfStateStore | Promise<WfStateStore>,
    options: WfStoreContractOptions = {},
): Promise<string[]> {
    const violations: string[] = [];
    const store = await makeStore();
    const probeMs = options.expiryProbeMs ?? 1000;
    const state = (n: number): WfState => ({
        schemaId: 'contract',
        context: { n, nested: { list: [1, 'two'] } },
        indexes: [n, 0],
        meta: { outlet: 'http', nested: { at: n } },
    });
    const later = () => Date.now() + 60_000;
    const sleepUntil = (at: number) =>
        new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));

    /** Run one rule with its own keys; keys are deleted even if it throws. */
    const check = async (
        rule: string,
        fn: (key: () => string) => Promise<string | void>,
    ) => {
        const used: string[] = [];
        const key = () => {
            // Same shape as a real hashed key: 5-char prefix + 43 base64url.
            const k = 'wfh1_' + randomBytes(32).toString('base64url');
            used.push(k);
            return k;
        };
        try {
            const problem = await fn(key);
            if (problem) violations.push(`${rule}: ${problem}`);
        } catch (error) {
            violations.push(`${rule}: threw ${(error as Error).message}`);
        } finally {
            for (const k of used) {
                try {
                    await store.delete(k);
                } catch {
                    // best effort
                }
            }
        }
    };

    await check('round-trip', async (key) => {
        const k = key();
        await store.set(k, state(1), later());
        const got = await store.get(k);
        if (!got) return 'get() returned null right after set()';
        if (!deepEqual(got.state, state(1))) {
            return 'state (including meta) does not come back as stored';
        }
    });

    await check('expiresAt echo', async (key) => {
        const k = key();
        const exp = later();
        await store.set(k, state(1), exp);
        const got = await store.get(k);
        if (got?.expiresAt !== undefined && got.expiresAt !== exp) {
            return `get() returned expiresAt ${got.expiresAt}, stored ${exp} (return the stored value or nothing)`;
        }
        const taken = await store.getAndDelete(k);
        if (taken?.expiresAt !== undefined && taken.expiresAt !== exp) {
            return `getAndDelete() returned expiresAt ${taken.expiresAt}, stored ${exp} (return the stored value or nothing)`;
        }
    });

    await check('side-effect free get', async (key) => {
        const k = key();
        await store.set(k, state(2), later());
        const before = await store.get(k);
        for (let i = 0; i < 3; i++) await store.get(k);
        await Promise.all([store.get(k), store.get(k)]);
        const after = await store.get(k);
        if (
            before?.expiresAt !== undefined &&
            after?.expiresAt !== before.expiresAt
        ) {
            return `get() changed the reported expiresAt (${before.expiresAt} → ${after?.expiresAt})`;
        }
        const taken = await store.getAndDelete(k);
        if (!taken) return 'entry is gone after get() calls';
    });

    await check('side-effect free get (expiry not extended)', async (key) => {
        // Size the probe by the store's round trip, so latency cannot read
        // as a violation.
        const scratch = key();
        let t = Date.now();
        await store.set(scratch, state(0), later());
        const setRtt = Date.now() - t;
        t = Date.now();
        await store.get(scratch);
        const rtt = Math.max(1, setRtt, Date.now() - t);
        const lifetime = Math.max(probeMs, 10 * rtt);
        const margin = Math.max(2 * rtt, Math.ceil(lifetime / 10));

        const k = key();
        const t0 = Date.now();
        const deadline = t0 + lifetime;
        await store.set(k, state(2), deadline);
        // Read several times inside the window, the last one late: a store
        // that slides the expiry on read (by more than ~20% of the lifetime,
        // e.g. by the original lifetime) keeps the entry alive past the
        // deadline.
        for (const f of [0, 0.25, 0.5, 0.75, 0.9]) {
            await sleepUntil(t0 + f * lifetime);
            if (Date.now() + rtt >= deadline) break;
            const got = await store.get(k);
            // Judged only when the read completed before the deadline.
            if (!got && Date.now() < deadline) {
                return 'entry missing before its expiry';
            }
        }
        await sleepUntil(deadline + margin);
        if (await store.get(k)) {
            return 'entry still returned after its expiry: get() extended it (or expiry is not enforced)';
        }
    });

    for (const n of options.concurrency ?? [2, 8, 32]) {
        await check(`atomic getAndDelete (${n} parallel)`, async (key) => {
            const k = key();
            await store.set(k, state(3), later());
            const results = await Promise.all(
                Array.from({ length: n }, () => store.getAndDelete(k)),
            );
            const winners = results.filter(Boolean).length;
            if (winners !== 1) {
                return `${winners} callers got the entry, expected 1`;
            }
            if (await store.get(k)) {
                return 'entry still present after getAndDelete';
            }
        });
    }

    await check('expiry honoured', async (key) => {
        const k1 = key();
        const k2 = key();
        await store.set(k1, state(4), Date.now() - 1);
        await store.set(k2, state(4), Date.now() - 1);
        const got = await store.get(k1);
        const taken = await store.getAndDelete(k2);
        if (got || taken) return 'an expired entry was returned';
    });

    await check('set overwrites', async (key) => {
        const k = key();
        await store.set(k, state(5), later());
        await store.set(k, state(6), later());
        const got = await store.get(k);
        if (!got || !deepEqual(got.state, state(6))) {
            return 'second set() did not replace the entry';
        }
    });

    await check('delete', async (key) => {
        const k = key();
        await store.set(k, state(7), later());
        await store.delete(k);
        if (await store.get(k)) return 'entry still present after delete()';
    });

    await check('exact key comparison', async (key) => {
        const k = key();
        await store.set(k, state(8), later());
        const fullwidth = [...k.slice(0, 5)]
            .map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
            .join('');
        const variants = [
            k.toUpperCase(),
            k.toLowerCase(),
            k + ' ',
            ' ' + k,
            'ẃ' + k.slice(1),
            fullwidth + k.slice(5),
        ].filter((v) => v !== k);
        const matched: string[] = [];
        for (const v of variants) {
            if (await store.get(v)) matched.push(JSON.stringify(v));
        }
        if (matched.length) {
            return `keys must compare exactly (binary, case-sensitive, NO PAD, no normalisation); also matched ${matched.join(', ')}`;
        }
    });

    return violations;
}

/** Structural equality of JSON values; object key order is ignored. */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        return (
            Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((v, i) => deepEqual(v, b[i]))
        );
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ra = a as Record<string, unknown>;
        const rb = b as Record<string, unknown>;
        const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
        const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
        return (
            ka.length === kb.length && ka.every((k) => deepEqual(ra[k], rb[k]))
        );
    }
    return false;
}
