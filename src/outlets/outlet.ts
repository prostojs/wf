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
}
