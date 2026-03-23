import { describe, it, expect } from 'vitest';
import { outlet, outletHttp, outletEmail } from './helpers';

describe('outlet helpers', () => {
    describe('outlet()', () => {
        it('returns inputRequired with outlet name', () => {
            const result = outlet('pending-task');
            expect(result).toEqual({
                inputRequired: { outlet: 'pending-task' },
            });
        });

        it('includes payload, target, and context', () => {
            const result = outlet('slack', {
                payload: { text: 'Approve?' },
                target: '#approvals',
                context: { orderId: 123 },
            });
            expect(result).toEqual({
                inputRequired: {
                    outlet: 'slack',
                    payload: { text: 'Approve?' },
                    target: '#approvals',
                    context: { orderId: 123 },
                },
            });
        });

        it('includes template', () => {
            const result = outlet('email', {
                target: 'user@test.com',
                template: 'welcome',
            });
            expect(result.inputRequired.outlet).toBe('email');
            expect(result.inputRequired.template).toBe('welcome');
            expect(result.inputRequired.target).toBe('user@test.com');
        });
    });

    describe('outletHttp()', () => {
        it('sets outlet name to http with payload', () => {
            const form = { fields: ['name', 'email'] };
            const result = outletHttp(form);
            expect(result).toEqual({
                inputRequired: {
                    outlet: 'http',
                    payload: form,
                },
            });
        });

        it('includes context', () => {
            const result = outletHttp('LoginForm', {
                error: 'Invalid credentials',
            });
            expect(result.inputRequired.outlet).toBe('http');
            expect(result.inputRequired.payload).toBe('LoginForm');
            expect(result.inputRequired.context).toEqual({
                error: 'Invalid credentials',
            });
        });
    });

    describe('outletEmail()', () => {
        it('sets outlet name to email with target and template', () => {
            const result = outletEmail('user@test.com', 'invite');
            expect(result).toEqual({
                inputRequired: {
                    outlet: 'email',
                    target: 'user@test.com',
                    template: 'invite',
                },
            });
        });

        it('includes context', () => {
            const result = outletEmail('user@test.com', 'invite', {
                name: 'Alice',
            });
            expect(result.inputRequired.context).toEqual({ name: 'Alice' });
        });
    });
});
