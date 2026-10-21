import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { WfState } from '../types';
import {
    consumeViaOverride,
    isOverridden,
    persistViaOverride,
} from './override';
import type {
    WfConsumedEntry,
    WfPersistedEntry,
    WfStateStrategy,
} from './strategy';
import type { WfStateStore, WfStateStoreEntry } from './store';
import { earliest, resolveExpiresAt } from './ttl';
import type { WfPersistOptions } from './ttl';

/** Options for `HandleStateConfig.hashHandles`. */
export interface WfHandleHashOptions {
    /**
     * HMAC-SHA-256 key. Omit the property to use plain SHA-256.
     *
     * Default handles (`crypto.randomUUID`, 122 random bits) are safe with
     * plain SHA-256: nobody can find a handle from its hash. Set a secret when
     * a custom `generateHandle` produces guessable handles, so a leaked store
     * cannot be brute-forced without the secret as well. Changing or removing
     * the secret makes every in-flight handle invalid.
     *
     * @throws when the property is present but `undefined` or empty (e.g. an
     * unset environment variable) — it never silently degrades to SHA-256.
     */
    secret?: string | Buffer;
    /**
     * Upgrade aid: when the hashed key misses, look the token up under its
     * raw (unhashed) key as well, so handles issued before `hashHandles` was
     * turned on still resume. Default: `true` with the default
     * `generateHandle`; with a custom `generateHandle` the fallback needs
     * `legacyHandle` and is off without it (`rawFallback: true` without
     * `legacyHandle` throws).
     *
     * The fallback only ever applies to tokens positively shaped like a
     * handle this strategy issued: a strict lowercase UUID v4 for the default
     * generator, or whatever `legacyHandle` accepts. Tokens that are not
     * printable ASCII (`/^[\x21-\x7e]+$/`: no whitespace, accents or
     * compatibility forms) or that contain `wfh`/`wfk` in any case never fall
     * back. An explicit `generateHandle` — even `randomUUID` — counts as
     * custom.
     *
     * @deprecated Temporary. Available in 0.3.x only; 0.4.0 removes the
     * option and the fallback (and inverts the consume/persist override
     * bridge, see `override.ts`). Handles that never expire (no
     * `defaultTtl`) and were issued before the upgrade stop resolving at
     * 0.4.0.
     */
    rawFallback?: boolean;
    /**
     * For a custom `generateHandle`: `true` when `token` has the exact shape
     * your generator issued before the upgrade. Required for the raw-key
     * fallback with a custom generator. Make it strict — it decides which
     * tokens may reach the store unhashed.
     *
     * @deprecated Goes away with `rawFallback` in 0.4.0.
     */
    legacyHandle?: (token: string) => boolean;
}

export interface HandleStateConfig {
    /** Storage backend */
    store: WfStateStore;
    /** Default TTL in ms. 0 = no expiry. */
    defaultTtl?: number;
    /**
     * Custom handle generator. Default: `crypto.randomUUID`; with
     * `hashHandles` on, 22 base64url characters (128 random bits) that never
     * contain `wfh`/`wfk` in any case — a shape the 0.3.x raw-key fallback
     * never considers, so new handles skip it entirely.
     */
    generateHandle?: () => string;
    /**
     * Store a hash of each handle instead of the handle itself. Default: off.
     *
     * The raw handle is only ever returned to the caller (the client's token);
     * the store keys entries by `hashWfHandle(handle, secret)`. A read of the
     * store (backup, replica, SQL injection, log) then yields no usable token.
     * Works with every `WfStateStore` that compares keys exactly (see
     * `WfStateStore`, rule 5); keys become 48-character strings.
     *
     * `true` = plain SHA-256 with the default raw-key fallback. See
     * `WfHandleHashOptions`.
     */
    hashHandles?: boolean | WfHandleHashOptions;
}

const SHA_PREFIX = 'wfh1_';
const HMAC_PREFIX = 'wfk1_';
/** Anything that resembles a hashed key, in any case. */
const HASHED_KEY_MARK = /wf[hk]/i;
/** The only characters a token may have to reach the raw-key fallback. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** `crypto.randomUUID()` output: lowercase UUID v4, nothing else. */
const DEFAULT_HANDLE_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The store key `HandleStateStrategy({ hashHandles })` uses for a handle:
 * `wfh1_` + base64url(SHA-256(handle)), or `wfk1_` + base64url(HMAC-SHA-256)
 * when a secret is given. Use it to reach a hashed entry in the store
 * directly, for example to revoke a handle.
 *
 * @throws if `secret` is given but empty
 */
export function hashWfHandle(handle: string, secret?: string | Buffer): string {
    if (secret === undefined) {
        return (
            SHA_PREFIX +
            createHash('sha256').update(handle, 'utf8').digest('base64url')
        );
    }
    if (secret.length === 0) {
        throw new Error('hashWfHandle: secret must not be empty');
    }
    return (
        HMAC_PREFIX +
        createHmac('sha256', secret).update(handle, 'utf8').digest('base64url')
    );
}

/** Default handle with `hashHandles` on: 128 random bits, never UUID-shaped or `wf[hk]`-like. */
function hashedModeHandle(): string {
    for (;;) {
        const handle = randomBytes(16).toString('base64url');
        if (!HASHED_KEY_MARK.test(handle)) return handle;
    }
}

/**
 * Server-side state strategy: the state lives in a `WfStateStore`, only a
 * random handle travels to the client.
 *
 * - `consume()` is single-use and race-safe when the store's `getAndDelete`
 *   is atomic (see the `WfStateStore` contract).
 * - `retrieve()` has no side effects.
 * - `persistEntry()` / `consumeEntry()` also report the absolute expiry. The
 *   strategy records the expiry it applied inside the persisted state (in
 *   `state.meta`, stripped again on read), so it is known even when the store
 *   leaves expiry to its backend and returns only `{ state }`.
 * - A subclass may override `consume()` / `persist()`: the `*Entry()`
 *   variants then delegate to the override and report the expiry as unknown.
 *   Call `super.consume()` / `super.persist()` from the override, never the
 *   `*Entry()` variants.
 * - `hashHandles` keeps the handles out of the store (see `HandleStateConfig`).
 */
export class HandleStateStrategy implements WfStateStrategy {
    private readonly hashSecret?: string | Buffer;
    private readonly hashing: boolean;
    private readonly newHandle: () => string;
    /** Which tokens may take the 0.3.x raw-key fallback; unset = none. */
    private readonly isLegacyHandle?: (token: string) => boolean;

    constructor(private config: HandleStateConfig) {
        const opt = config.hashHandles;
        this.hashing = !!opt;
        const options: WfHandleHashOptions = typeof opt === 'object' ? opt : {};
        if (
            'secret' in options &&
            (options.secret === undefined || options.secret.length === 0)
        ) {
            throw new Error(
                'HandleStateStrategy: hashHandles.secret is present but undefined or empty — pass a secret, or omit the property for plain SHA-256',
            );
        }
        this.hashSecret = options.secret;
        this.newHandle =
            config.generateHandle ??
            (this.hashing ? hashedModeHandle : randomUUID);
        if (this.hashing && options.rawFallback !== false) {
            const accept = options.legacyHandle;
            if (accept) {
                // Printable ASCII only (no whitespace, accents or compatibility
                // forms a case-, accent- or width-insensitive collation could
                // fold onto a hashed key), never anything `wf[hk]`-like.
                this.isLegacyHandle = (t) =>
                    PRINTABLE_ASCII.test(t) &&
                    !HASHED_KEY_MARK.test(t) &&
                    accept(t);
            } else if (!config.generateHandle) {
                this.isLegacyHandle = (t) => DEFAULT_HANDLE_RE.test(t);
            } else if (options.rawFallback === true) {
                throw new Error(
                    'HandleStateStrategy: hashHandles.rawFallback with a custom generateHandle needs hashHandles.legacyHandle',
                );
            }
        }
    }

    async persist(
        state: WfState,
        options?: WfPersistOptions,
        overrides?: { handle?: string },
    ): Promise<string> {
        return (await this.write(state, options, overrides)).token;
    }

    /** `persist()` plus the expiry applied. See `WfStateStrategy.persistEntry`. */
    async persistEntry(
        state: WfState,
        options?: WfPersistOptions,
        overrides?: { handle?: string },
    ): Promise<WfPersistedEntry> {
        if (isOverridden(this, HandleStateStrategy, 'persist')) {
            return persistViaOverride(this, state, options, overrides);
        }
        return this.write(state, options, overrides);
    }

    async retrieve(token: string): Promise<WfState | null> {
        return (await this.lookup(token, 'get'))?.state ?? null;
    }

    async consume(token: string): Promise<WfState | null> {
        return (await this.lookup(token, 'getAndDelete'))?.state ?? null;
    }

    /** `consume()` plus the expiry (`undefined` = unknown). See `WfStateStrategy.consumeEntry`. */
    async consumeEntry(token: string): Promise<WfConsumedEntry | null> {
        if (isOverridden(this, HandleStateStrategy, 'consume')) {
            return consumeViaOverride(this, token);
        }
        return this.lookup(token, 'getAndDelete');
    }

    private async write(
        state: WfState,
        options: WfPersistOptions | undefined,
        overrides: { handle?: string } | undefined,
    ): Promise<WfPersistedEntry> {
        const expiresAt = resolveExpiresAt(options, this.config.defaultTtl);
        const handle = overrides?.handle ?? this.newHandle();
        const legacy = this.legacyKey(handle);
        if (overrides?.handle !== undefined && legacy !== undefined) {
            // A re-used handle may still have a pre-upgrade entry under its
            // raw key. Remove it BEFORE writing the hashed one, so the state
            // never exists under both keys (two keys = two consumes succeed).
            await this.config.store.delete(legacy);
        }
        await this.config.store.set(
            this.keyOf(handle),
            seal(state, expiresAt ?? 0),
            expiresAt,
        );
        return { token: handle, expiresAt: expiresAt ?? 0 };
    }

    /**
     * Read (`get`) or take (`getAndDelete`) the entry for a token, falling
     * back to its raw key for pre-upgrade handles.
     */
    private async lookup(
        token: string,
        op: 'get' | 'getAndDelete',
    ): Promise<WfConsumedEntry | null> {
        const { store } = this.config;
        // Each getAndDelete is atomic and an entry lives under one key only,
        // so among concurrent consumers exactly one gets it.
        let entry = await store[op](this.keyOf(token));
        const legacy = entry ? undefined : this.legacyKey(token);
        if (legacy !== undefined) entry = await store[op](legacy);
        return open(entry);
    }

    /** The store key for a handle. */
    private keyOf(handle: string): string {
        return this.hashing ? hashWfHandle(handle, this.hashSecret) : handle;
    }

    /**
     * The raw key to try when the hashed one misses (0.3.x upgrade aid), or
     * `undefined`. Only tokens positively shaped like a pre-upgrade handle
     * qualify (see the constructor), so a key read from the store cannot be
     * replayed as a token — not even through a store whose key comparison
     * ignores case, padding, accents or normalisation.
     */
    private legacyKey(token: string): string | undefined {
        return this.isLegacyHandle?.(token) ? token : undefined;
    }
}

// ---------------------------------------------------------------------------
// Expiry envelope: the strategy records the absolute expiry it applied inside
// the persisted state (state.meta), so it does not depend on the store
// echoing `expiresAt`. Stripped again on every read.
// ---------------------------------------------------------------------------

const ENVELOPE_KEY = '__wfExpiry';

interface Envelope {
    /** Absolute expiry (ms timestamp); 0 = never. */
    at: number;
    /** The caller's state had no `meta`. */
    bare?: 1;
}

function seal(state: WfState, at: number): WfState {
    const envelope: Envelope = state.meta ? { at } : { at, bare: 1 };
    return { ...state, meta: { ...state.meta, [ENVELOPE_KEY]: envelope } };
}

function isEnvelope(v: unknown): v is Envelope {
    const at = (v as Envelope | undefined)?.at;
    return typeof at === 'number' && Number.isFinite(at) && at >= 0;
}

/**
 * The live entry with its known expiry, or `null` when missing or expired.
 * The expiry is checked here as well (second line of defence for stores that
 * do not enforce it): the earlier of the envelope and the store's bound.
 */
function open(
    entry: WfStateStoreEntry | null | undefined,
): WfConsumedEntry | null {
    if (!entry?.state) return null;
    let state = entry.state;
    let recorded: number | undefined;
    if (state.meta && ENVELOPE_KEY in state.meta) {
        const { [ENVELOPE_KEY]: envelope, ...meta } = state.meta;
        state = { ...state, meta };
        if (isEnvelope(envelope)) {
            recorded = envelope.at;
            if (envelope.bare && Object.keys(meta).length === 0) {
                delete state.meta;
            }
        }
    }
    // Earliest known bound; else 0 = never (recorded), undefined = unknown.
    const expiresAt =
        earliest(recorded, entry.expiresAt) ?? (recorded === 0 ? 0 : undefined);
    if (expiresAt && Date.now() > expiresAt) return null;
    return { state, expiresAt };
}
