import type { WfOutletRequest, WfOutletResult } from './types';

/**
 * An outlet delivers a workflow pause to the outside world.
 *
 * Built-in outlets (HTTP, email) ship in higher-level packages.
 * Users implement this interface for custom delivery mechanisms
 * (Slack, pending tasks, webhooks, push notifications, etc.).
 */
export interface WfOutlet {
    /** Unique outlet name. Steps reference this in outlet requests. */
    readonly name: string;

    /**
     * Deliver a workflow pause.
     *
     * @param request — what the step requested (outlet name, payload, target, context)
     * @param token   — serialized state token (encrypted blob or DB handle).
     *                  The outlet embeds this in whatever it delivers so the workflow
     *                  can be resumed later.
     * @returns what to send back to the caller, or void if the outlet handles
     *          the response itself (e.g., email outlets return a confirmation).
     */
    deliver(
        request: WfOutletRequest,
        token: string,
    ): Promise<WfOutletResult | void>;

    /**
     * How the resumption token reaches the resumer.
     *
     * - `"caller"` (default) — the HTTP caller who triggered the pause is also
     *   the resumer (e.g. HTTP form step, multi-step wizard). The trigger layer
     *   is allowed to include the token in the HTTP response (body merge or
     *   `Set-Cookie`) so the caller can submit the next step.
     *
     * - `"out-of-band"` — the token travels through the outlet's own channel
     *   (email magic link, SMS OTP, Slack button, webhook callback). The
     *   caller who triggered the pause is a bystander — they MUST NOT receive
     *   the token in the HTTP response. Trigger-layer body merge and cookie
     *   write are suppressed for this outlet.
     *
     * Omitting this field is equivalent to `"caller"` and is only appropriate
     * for same-session continuation outlets. Any outlet that delivers to a
     * different principal than the caller MUST declare `"out-of-band"`.
     */
    readonly tokenDelivery?: 'caller' | 'out-of-band';
}
