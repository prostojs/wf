import type { WfState } from '../types';

/** A stored workflow state and its absolute expiry (ms timestamp). */
export interface WfStateStoreEntry {
    state: WfState;
    /**
     * Absolute expiry as a ms timestamp. `undefined` (or `0`) = never expires,
     * or not reported by the store (rule 6).
     */
    expiresAt?: number;
}

/**
 * Backend for `HandleStateStrategy`.
 *
 * Built-in: `WfStateStoreMemory` (dev/testing).
 * Production: implement it for your database.
 *
 * ## Contract
 *
 * Every implementation MUST meet these rules. `HandleStateStrategy` builds
 * single-use resumption tokens on them, so breaking one is a security bug
 * (a token can be used twice), not a performance issue.
 *
 * 1. **`getAndDelete` is atomic.** When several calls for the same live key
 *    run concurrently (in one process or across processes), exactly ONE of
 *    them returns the entry and every other one returns `null`. A read
 *    followed by a separate delete is NOT atomic, even inside one process:
 *    any `await` between the read and the delete lets a second caller read
 *    the same entry. Use one atomic operation of your backend, for example
 *    `DELETE ... RETURNING` (PostgreSQL, SQLite), `GETDEL` or a Lua script
 *    (Redis), `findOneAndDelete` (MongoDB), or a transaction that locks the
 *    row (`SELECT ... FOR UPDATE` then `DELETE`).
 * 2. **`get` is side-effect free.** It never deletes, extends or changes a
 *    live entry. Dropping an entry that has already expired is allowed (it is
 *    not observable).
 * 3. **Expired entries are never returned.** `get` and `getAndDelete` return
 *    `null` once `Date.now() > expiresAt`. `HandleStateStrategy` checks the
 *    expiry again as a second line of defence, but a store that returns
 *    expired entries from `getAndDelete` still loses the single-use
 *    guarantee for them. A store may enforce expiry in its backend (Redis
 *    `PX`, a MongoDB TTL index) — then it must also accept an `expiresAt`
 *    that is already in the past (store nothing, or store it expired).
 * 4. **`set` overwrites.** Storing under an existing key replaces the entry
 *    and its expiry.
 * 5. **Keys compare exactly.** Binary, case-sensitive, no padding, no
 *    Unicode normalisation — the key a caller passes must match only the key
 *    that was stored, byte for byte. A case-insensitive or PAD SPACE
 *    comparison lets altered spellings of a key reach an entry.
 *    - MySQL/MariaDB: `VARBINARY(64)`, or `VARCHAR(64) COLLATE
 *      utf8mb4_0900_bin` (NO PAD). Not the default `*_ci` collations and not
 *      `utf8mb4_bin`, which is PAD SPACE.
 *    - SQL Server: a `VARBINARY(64)` column; `(n)varchar` ignores trailing
 *      spaces in `=` under every collation, and the default collations are
 *      case-insensitive. At minimum a `_BIN2` collation.
 *    - PostgreSQL: `text` / `varchar` with a deterministic collation
 *      (the default, or `COLLATE "C"`); not `citext` and not a
 *      nondeterministic ICU collation.
 *    With `HandleStateStrategy({ hashHandles })` a key is a 48-character hash
 *    (`wfh1_`/`wfk1_` + base64url), not the handle, so a column typed as
 *    UUID must become a text/binary column.
 * 6. **`expiresAt` is echoed exactly or not at all.** When `get` /
 *    `getAndDelete` return `expiresAt`, it is the value passed to `set`.
 *    A store that cannot report it (backend TTL) returns `{ state }` only.
 * 7. **The state round-trips**, including `state.meta` (serialised as JSON
 *    is fine). `HandleStateStrategy` records the expiry it applied in
 *    `state.meta`; a store that drops `meta` makes that expiry unknown, so
 *    consumed tokens of that store can never be restored.
 *
 * Check an implementation with `checkWfStateStoreContract` from
 * `@prostojs/wf/testing`.
 */
export interface WfStateStore {
    /** Store state under a key with an optional absolute expiry (ms timestamp). Overwrites. */
    set(handle: string, state: WfState, expiresAt?: number): Promise<void>;
    /** Read an entry WITHOUT side effects. `null` if missing or expired. */
    get(handle: string): Promise<WfStateStoreEntry | null>;
    /** Delete a key (revocation). */
    delete(handle: string): Promise<void>;
    /**
     * ATOMICALLY read and delete an entry. `null` if missing or expired.
     * Among concurrent calls for the same key exactly one gets the entry.
     */
    getAndDelete(handle: string): Promise<WfStateStoreEntry | null>;
    /** Remove all expired entries. Returns the count removed. Optional. */
    cleanup?(): Promise<number>;
}
