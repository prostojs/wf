import type { TFlowState } from '../types';

/**
 * Serializable workflow state — everything needed to resume a paused workflow.
 * Untyped alias of TFlowState for use in persistence/transport layers.
 */
export type WfState = TFlowState<unknown>;

/**
 * What a workflow step produces when it pauses via an outlet.
 * This is the `inputRequired` value in TFlowOutput.
 */
export interface WfOutletRequest<P = unknown> {
    /** Which outlet to use (e.g., 'http', 'email', 'pending-task') */
    outlet: string;
    /** Payload for the outlet (form definition, task data, message, etc.) */
    payload?: P;
    /** Target recipient (email address, user ID, Slack channel, etc.) */
    target?: string;
    /** Template identifier (for email/notification outlets) */
    template?: string;
    /** Additional context passed to the outlet handler */
    context?: Record<string, unknown>;
}

/**
 * What an outlet returns after delivering the pause.
 * Tells the framework how to respond to the caller.
 */
export interface WfOutletResult {
    /** Response body (for outlets that respond synchronously, like HTTP) */
    response?: unknown;
    /** HTTP status code */
    status?: number;
    /** Headers to set on the response */
    headers?: Record<string, string>;
    /** Cookies to set */
    cookies?: Record<string, WfCookieValue>;
}

export interface WfCookieValue {
    value: string;
    options?: {
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: 'strict' | 'lax' | 'none';
        path?: string;
        domain?: string;
        maxAge?: number;
        expires?: Date;
    };
}
