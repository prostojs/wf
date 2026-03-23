import type { TStepOutput } from '../types';
import type { WfOutletRequest } from './types';

type WfOutletSignal<P> = NonNullable<TStepOutput<WfOutletRequest<P>>>;

/**
 * Generic outlet request. Use for custom outlets.
 *
 * @example
 * return outlet('pending-task', {
 *   payload: ApprovalForm,
 *   target: managerId,
 *   context: { orderId, amount },
 * })
 */
export function outlet<P = unknown>(
    name: string,
    data?: Omit<WfOutletRequest<P>, 'outlet'>,
): WfOutletSignal<P> {
    return {
        inputRequired: { outlet: name, ...data },
    };
}

/**
 * Pause for HTTP form input. The outlet returns the payload (form definition)
 * and state token in the HTTP response.
 *
 * @example
 * return outletHttp(LoginForm)
 * return outletHttp(LoginForm, { error: 'Invalid credentials' })
 */
export function outletHttp<P = unknown>(
    payload: P,
    context?: Record<string, unknown>,
): WfOutletSignal<P> {
    return outlet('http', { payload, context });
}

/**
 * Pause and send email with a magic link containing the state token.
 *
 * @example
 * return outletEmail('user@test.com', 'invite', { name: 'Alice' })
 */
export function outletEmail(
    target: string,
    template: string,
    context?: Record<string, unknown>,
): WfOutletSignal<unknown> {
    return outlet('email', { target, template, context });
}
