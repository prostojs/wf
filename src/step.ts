import { FtringsPool } from '@prostojs/ftring';
import { TStepHandler, TStepOutput, StepRetriableError } from './types';

const fnPool = new FtringsPool<TStepOutput<any>, Record<string, any>>();

export interface StepOptions<I> {
    globals?: Record<string, unknown>;
    input?: I;
}

/**
 * Workflow Step
 *
 * A minimum action withing workflow
 *
 * @example
 * new Step('step0', (ctx, input) => {
 *      ctx.step0Data = 'completed'
 *      console.log('step0 completed')
 *  })
 */
export class Step<T, I, IR> {
    constructor(
        public readonly id: string,
        protected handler: string | TStepHandler<T, I, IR>,
        protected opts: StepOptions<I> = {},
    ) {}

    protected _handler?: TStepHandler<T, I, IR>;

    public getGlobals(ctx: T, input: I): Record<string, unknown> {
        const globals = Object.assign({ StepRetriableError }, this.opts.globals);
        globals.ctx = ctx;
        globals.input = input;
        return globals;
    }

    public handle(ctx: T, input: I) {
        if (this.opts.input && typeof input === 'undefined') {
            return { inputRequired: this.opts.input } as TStepOutput<IR>;
        }
        if (!this._handler) {
            if (typeof this.handler === 'string') {
                const code = this.handler;
                this._handler = (ctx: T, input: I) =>
                    fnPool.call(code, this.getGlobals(ctx, input));
            } else {
                this._handler = this.handler;
            }
        }
        return this._handler(ctx, input);
    }
}

/**
 * Shortcut for creating a workflow step
 * @param id step id
 * @param opts.input optional - instructions for step inputs
 * @param opts.handler step handler
 * @returns Step
 */
export function createStep<T = any, I = any, IR = any>(
    id: string,
    opts: {
        input?: I;
        handler: string | TStepHandler<T, I, IR>;
    },
) {
    return new Step<T, I, IR>(id, opts.handler, { input: opts.input });
}
