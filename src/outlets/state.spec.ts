import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EncapsulatedStateStrategy } from './state/encapsulated';
import { HandleStateStrategy } from './state/handle';
import { WfStateStoreMemory } from './state/memory';
import type { WfState } from './types';

const testState: WfState = {
    schemaId: 'test-flow',
    context: { result: 42, user: 'alice' },
    indexes: [2, 1],
};

describe('EncapsulatedStateStrategy', () => {
    const secret = randomBytes(32);
    let strategy: EncapsulatedStateStrategy;

    beforeEach(() => {
        strategy = new EncapsulatedStateStrategy({ secret });
    });

    it('round-trips state through persist + retrieve', async () => {
        const token = await strategy.persist(testState);
        expect(typeof token).toBe('string');
        expect(token.length).toBeGreaterThan(0);

        const retrieved = await strategy.retrieve(token);
        expect(retrieved).toEqual(testState);
    });

    it('returns null for expired token', async () => {
        const token = await strategy.persist(testState, { ttl: 1 });
        // Wait for expiry
        await new Promise((r) => setTimeout(r, 10));
        const retrieved = await strategy.retrieve(token);
        expect(retrieved).toBeNull();
    });

    it('returns null for tampered token', async () => {
        const token = await strategy.persist(testState);
        // Flip a character in the middle
        const tampered =
            token.slice(0, 20) +
            (token[20] === 'A' ? 'B' : 'A') +
            token.slice(21);
        const retrieved = await strategy.retrieve(tampered);
        expect(retrieved).toBeNull();
    });

    it('returns null with wrong key', async () => {
        const token = await strategy.persist(testState);
        const other = new EncapsulatedStateStrategy({
            secret: randomBytes(32),
        });
        const retrieved = await other.retrieve(token);
        expect(retrieved).toBeNull();
    });

    it('consume returns same as retrieve (stateless)', async () => {
        const token = await strategy.persist(testState);
        const consumed = await strategy.consume(token);
        expect(consumed).toEqual(testState);
        // Can consume again (stateless)
        const again = await strategy.consume(token);
        expect(again).toEqual(testState);
    });

    it('returns null for empty/short token', async () => {
        expect(await strategy.retrieve('')).toBeNull();
        expect(await strategy.retrieve('abc')).toBeNull();
    });

    it('throws if secret is not 32 bytes', () => {
        expect(
            () =>
                new EncapsulatedStateStrategy({
                    secret: randomBytes(16),
                }),
        ).toThrow('32 bytes');
    });

    it('accepts hex string secret', async () => {
        const hex = randomBytes(32).toString('hex');
        const s = new EncapsulatedStateStrategy({ secret: hex });
        const token = await s.persist(testState);
        expect(await s.retrieve(token)).toEqual(testState);
    });
});

describe('HandleStateStrategy', () => {
    let store: WfStateStoreMemory;
    let strategy: HandleStateStrategy;

    beforeEach(() => {
        store = new WfStateStoreMemory();
        strategy = new HandleStateStrategy({ store });
    });

    it('round-trips state through persist + retrieve', async () => {
        const handle = await strategy.persist(testState);
        expect(typeof handle).toBe('string');

        const retrieved = await strategy.retrieve(handle);
        expect(retrieved).toEqual(testState);
    });

    it('returns null for expired handle', async () => {
        const handle = await strategy.persist(testState, { ttl: 1 });
        await new Promise((r) => setTimeout(r, 10));
        const retrieved = await strategy.retrieve(handle);
        expect(retrieved).toBeNull();
    });

    it('consume retrieves then deletes', async () => {
        const handle = await strategy.persist(testState);
        const consumed = await strategy.consume(handle);
        expect(consumed).toEqual(testState);

        // Second consume returns null
        const again = await strategy.consume(handle);
        expect(again).toBeNull();
    });

    it('returns null for missing handle', async () => {
        const retrieved = await strategy.retrieve('nonexistent');
        expect(retrieved).toBeNull();
    });

    it('uses custom handle generator', async () => {
        let counter = 0;
        const custom = new HandleStateStrategy({
            store,
            generateHandle: () => `handle-${++counter}`,
        });
        const h1 = await custom.persist(testState);
        const h2 = await custom.persist(testState);
        expect(h1).toBe('handle-1');
        expect(h2).toBe('handle-2');
    });

    it('respects defaultTtl config', async () => {
        const ttlStrategy = new HandleStateStrategy({
            store,
            defaultTtl: 1,
        });
        const handle = await ttlStrategy.persist(testState);
        await new Promise((r) => setTimeout(r, 10));
        expect(await ttlStrategy.retrieve(handle)).toBeNull();
    });
});

describe('WfStateStoreMemory', () => {
    let store: WfStateStoreMemory;

    beforeEach(() => {
        store = new WfStateStoreMemory();
    });

    it('set + get round-trip', async () => {
        await store.set('h1', testState);
        const entry = await store.get('h1');
        expect(entry).toEqual({ state: testState });
    });

    it('get returns null for missing handle', async () => {
        expect(await store.get('missing')).toBeNull();
    });

    it('delete removes entry', async () => {
        await store.set('h1', testState);
        await store.delete('h1');
        expect(await store.get('h1')).toBeNull();
    });

    it('stores expiresAt', async () => {
        const exp = Date.now() + 60000;
        await store.set('h1', testState, exp);
        const entry = await store.get('h1');
        expect(entry?.expiresAt).toBe(exp);
    });

    it('cleanup removes expired entries', async () => {
        await store.set('expired', testState, Date.now() - 1000);
        await store.set('valid', testState, Date.now() + 60000);
        await store.set('no-expiry', testState);

        const removed = await store.cleanup();
        expect(removed).toBe(1);
        expect(await store.get('expired')).toBeNull();
        expect(await store.get('valid')).not.toBeNull();
        expect(await store.get('no-expiry')).not.toBeNull();
    });
});
