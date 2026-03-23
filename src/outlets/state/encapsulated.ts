import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { WfState } from '../types';
import type { WfStateStrategy } from './strategy';

export interface EncapsulatedStateConfig {
    /** Encryption secret — 32 bytes as hex string or Buffer */
    secret: string | Buffer;
    /** Default TTL in ms. 0 = no expiry. */
    defaultTtl?: number;
}

/**
 * Self-contained AES-256-GCM encrypted state strategy.
 *
 * Workflow state is encrypted into a base64url token that travels with the
 * transport (cookie, URL param, hidden field). No server-side storage needed.
 *
 * Token format: `base64url(iv[12] + authTag[16] + ciphertext)`
 *
 * @example
 * const strategy = new EncapsulatedStateStrategy({
 *     secret: crypto.randomBytes(32),
 *     defaultTtl: 3600_000, // 1 hour
 * });
 * const token = await strategy.persist(state);
 * const recovered = await strategy.retrieve(token);
 */
export class EncapsulatedStateStrategy implements WfStateStrategy {
    private key: Buffer;

    /** @throws if secret is not exactly 32 bytes */
    constructor(private config: EncapsulatedStateConfig) {
        this.key =
            typeof config.secret === 'string'
                ? Buffer.from(config.secret, 'hex')
                : config.secret;
        if (this.key.length !== 32) {
            throw new Error(
                'EncapsulatedStateStrategy: secret must be exactly 32 bytes',
            );
        }
    }

    /**
     * Encrypt workflow state into a self-contained token.
     * @param state — workflow state to persist
     * @param options.ttl — time-to-live in ms (overrides defaultTtl)
     * @returns base64url-encoded encrypted token
     */
    async persist(state: WfState, options?: { ttl?: number }): Promise<string> {
        const ttl = options?.ttl ?? this.config.defaultTtl ?? 0;
        const exp = ttl > 0 ? Date.now() + ttl : 0;
        const payload = JSON.stringify({ s: state, e: exp });

        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([
            cipher.update(payload, 'utf8'),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();

        // Format: base64url(iv + tag + ciphertext)
        return Buffer.concat([iv, tag, encrypted]).toString('base64url');
    }

    /** Decrypt and return workflow state. Returns null if token is invalid, expired, or tampered. */
    async retrieve(token: string): Promise<WfState | null> {
        return this.decrypt(token);
    }

    /** Same as retrieve (stateless — cannot truly invalidate a token). */
    async consume(token: string): Promise<WfState | null> {
        // Stateless — cannot invalidate. Same as retrieve.
        return this.decrypt(token);
    }

    private decrypt(token: string): WfState | null {
        try {
            const buf = Buffer.from(token, 'base64url');
            if (buf.length < 28) return null; // 12 (iv) + 16 (tag) minimum

            const iv = buf.subarray(0, 12);
            const tag = buf.subarray(12, 28);
            const ciphertext = buf.subarray(28);

            const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
            decipher.setAuthTag(tag);
            const decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]);

            const { s: state, e: exp } = JSON.parse(decrypted.toString('utf8'));
            if (exp > 0 && Date.now() > exp) return null; // expired

            return state as WfState;
        } catch {
            return null; // tampered, corrupted, or wrong key
        }
    }
}
