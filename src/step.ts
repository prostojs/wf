/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateFn } from './utils/generate-fn'
import { TStepHandler, TStepOutput, StepRetriableError } from './types'

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
export class Step<T, I, D> {
    constructor(
        public readonly id: string,
        protected handler: string | TStepHandler<T, I, D>,
        protected globals: Record<string, unknown> = {}
    ) { }

    protected _handler?: TStepHandler<T, I, D>

    public getGlobals(ctx: T, input: I): Record<string, unknown> {
        return { StepRetriableError, ...this.globals, ctx, input }
    }

    public handle(ctx: T, input: I) {
        if (!this._handler) {
            if (typeof this.handler === 'string') {
                const fn = generateFn<TStepOutput>(this.handler)
                this._handler = (ctx: T, input: I) => fn(this.getGlobals(ctx, input))
            } else {
                this._handler = this.handler
            }
        }
        return this._handler(ctx, input)
    }
}

/**
 * Shortcut for creating a workflow step
 * @param id step id
 * @param opts.input optional - instructions for step inputs
 * @param opts.handler step handler
 * @returns Step
 */
export function createStep<T = any, I = any, D = any>(id: string, opts: {
    input?: D
    handler: string | TStepHandler<T, I, D>
}) {
    let _handler: TStepHandler<T, I, D>
    const step = new Step<T, I, D>(id, async (ctx, input) => {
        if (opts.input && typeof input === 'undefined') {
            return { inputRequired: opts.input }
        }
        return await _handler(ctx, input)
    })
    if (typeof opts.handler === 'string') {
        const fn = generateFn<TStepOutput>(opts.handler)
        _handler = (ctx: T, input: I) => fn(step.getGlobals(ctx, input))
    } else {
        _handler = opts.handler
    }
    return step
}
