/* eslint-disable @typescript-eslint/no-explicit-any */
import { TFlowOutput, TWorkflowItem, TWorkflowSchema, TWorkflowStepConditionFn, StepRetriableError, TSubWorkflowSchemaObj, TWorkflowStepSchemaObj, TWorkflowControl } from './types'
import { Step } from './step'
import { generateFn } from './utils/generate-fn'

/**
 * Workflow container
 * 
 * @example
 * const steps = [
 *     createStep('add', {
 *         input: 'number',
 *         handler: 'ctx.result += input',
 *     }),
 *     createStep('mul', {
 *         input: 'number',
 *         handler: 'ctx.result *= input',
 *     }),
 *     createStep('div', {
 *         input: 'number',
 *         handler: 'ctx.result = ctx.result / input',
 *     }),
 *     createStep('error', {
 *         handler: 'ctx.result < 0 ? new StepRetriableError(new Error("test error")) : undefined',
 *     }),
 * ]
 * const flow = new Workflow<{ result: number }>(steps)
 * flow.register('add-mul-div', [
 *     'add', 'mul', 'div',
 * ])
 * const result = await flow.start('add-mul-div', { result: 1 })
 */
export class Workflow<T> {
    protected mappedSteps: Record<string, Step<T, any, any>> = {}

    protected schemas: Record<string, TWorkflowSchema<T>> = {}

    protected fns: Record<symbol, TWorkflowStepConditionFn<T>> = {}

    constructor(protected steps: Step<T, any, any>[]) {
        for (const step of steps) {
            if (this.mappedSteps[step.id]) {
                throw new Error(`Duplicate step id "${ step.id }"`)
            }
            this.mappedSteps[step.id] = step
        }
    }

    protected resolveStep(stepId: string) {
        return this.mappedSteps[stepId]
    }

    public addStep<I, D>(step: Step<T, I, D>) {
        if (this.mappedSteps[step.id]) {
            throw new Error(`Duplicate step id "${step.id}"`)
        }
        this.steps.push(step)
        this.mappedSteps[step.id] = step
    }

    /**
     * Validate that schema refers only to existing step IDs
     * @param schemaId 
     * @param item 
     */
    protected validateSchema(schemaId: string, item: TWorkflowItem<T>) {
        const { stepId, steps } = this.normalizeWorkflowItem(item)
        if (typeof stepId === 'string') {
            if (!this.resolveStep(stepId)) error(stepId)
        } else if (steps) {
            for (const step of steps) {
                this.validateSchema(schemaId, step)
            }
        }
        function error(id: string) {
            throw new Error(`Workflow schema "${ schemaId }" refers to an unknown step id "${ id }".`)
        }
    }

    /**
     * Register flow (sequence of steps) under ID
     * @param id 
     * @param schema 
     */
    register(id: string, schema: TWorkflowSchema<T>) {
        if (!this.schemas[id]) {
            for (const step of schema) {
                this.validateSchema(id, step)
            }
            this.schemas[id] = schema
        } else {
            throw new Error(`Workflow schema with id "${ id }" already registered.`)
        }
    }

    /**
     * Start flow by ID
     * @param schemaId 
     * @param inputContext initial context
     * @param input initial input (for the first step if required)
     * @returns 
     */
    start<I>(schemaId: string, inputContext: T, input?: I): Promise<TFlowOutput<T, I>> {
        const schema = this.schemas[schemaId]
        if (!schema) {
            throw new Error(`Workflow schema id "${ schemaId }" does not exist.`)
        }
        return this.loopInto({
            schemaId,
            context: inputContext,
            schema,
            input,
        })
    }

    protected async callConditionFn(fn: string | TWorkflowStepConditionFn<T>, context: T): Promise<boolean> {
        if (typeof fn === 'string') {
            const symbol = Symbol.for(fn)
            if (!this.fns[symbol]) {
                this.fns[symbol] = generateFn<Promise<boolean>>(fn) as TWorkflowStepConditionFn<T>
            }
            return (await this.fns[symbol](context))
        } else {
            return (await fn(context))
        }
    }

    protected async loopInto<I>(opts: {
        schemaId: string
        schema: TWorkflowSchema<T>
        context: T
        input?: I
        indexes?: number[]
        level?: number
    }): Promise<TFlowOutput<T, unknown>> {
        const schema = opts.schema
        const level = opts.level || 0
        const indexes = opts.indexes = opts.indexes || []
        const startIndex = indexes[level] || 0
        let skipCondition = indexes.length > level + 1 // skip condition when re-try (resume)
        indexes[level] = startIndex
        let input = opts.input
        let result: TFlowOutput<T, unknown> = {
            schemaId: opts.schemaId,
            state: { context: opts.context, indexes },
            finished: false,
            stepId: '',
        }
        try {
            for (let i = startIndex; i < schema.length; i++) {
                indexes[level] = i
                const item = this.normalizeWorkflowItem(schema[i])
                if (item.continueFn) {
                    if (await this.callConditionFn(item.continueFn, result.state.context)) {
                        result.break = false
                        break
                    }
                }
                if (item.breakFn) {
                    if (await this.callConditionFn(item.breakFn, result.state.context)) {
                        result.break = true
                        break
                    }
                }
                if (!skipCondition && item.conditionFn) {
                    if (!(await this.callConditionFn(item.conditionFn, result.state.context))) continue
                }
                skipCondition = false
                if (typeof item.stepId === 'string') {
                    result.stepId = item.stepId
                    const step = this.resolveStep(item.stepId)
                    if (!step) {
                        throw new Error(`Step "${item.stepId}" not found.`)
                    }
                    let mergedInput = input
                    if (typeof item.input !== 'undefined') {
                        if (typeof input === 'undefined') {
                            mergedInput = item.input as I
                        } else if (typeof item.input === 'object' && typeof input === 'object') {
                            mergedInput = { ...item.input, ...input } as I
                        }
                    }
                    const stepResult = await step.handle(result.state.context, mergedInput)
                    if (stepResult && stepResult.inputRequired) {
                        result.interrupt = true
                        result.inputRequired = stepResult.inputRequired
                        break
                    }
                    if (stepResult && stepResult instanceof StepRetriableError) {
                        retriableError(stepResult)
                        break
                    }
                } else if (item.steps) {
                    while (true) {
                        if (item.whileFn) {
                            if (!(await this.callConditionFn(item.whileFn, result.state.context))) break
                        }
                        result = await this.loopInto({
                            schemaId: opts.schemaId,
                            schema: item.steps,
                            context: result.state.context,
                            indexes,
                            input,
                            level: level + 1,
                        })
                        if (!item.whileFn || result.break || result.interrupt) break
                    }
                    result.break = false
                    if (result.interrupt) break
                }
                input = undefined
            }
        } catch (e) {
            if (e instanceof StepRetriableError) {
                retriableError(e)
            } else {
                throw e
            }
        }
        function retriableError(e: StepRetriableError<any>) {
            result.interrupt = true
            result.error = e.originalError
            result.inputRequired = e.inputRequired
        }
        if (result.interrupt) {
            if (level === 0) {
                const resume = (input: unknown) => this.resume(opts.schemaId, result.state, input)
                if (result.error) {
                    result.retry = resume
                } else {
                    result.resume = resume
                }
            }
            return result
        }
        indexes.pop()
        if (level === 0) {
            result.finished = true
        }
        return result
    }

    protected getItemStepId<T>(item: TWorkflowItem<T>): string | undefined {
        return typeof item === 'string' ? item : (item as TWorkflowStepSchemaObj<T, any>).id
    }

    protected normalizeWorkflowItem<T, I>(item: TWorkflowItem<T>): {
        stepId?: string
        input?: I
        steps?: TWorkflowSchema<T>
        conditionFn?: string | TWorkflowStepConditionFn<T>
        continueFn?: string | TWorkflowStepConditionFn<T>
        breakFn?: string | TWorkflowStepConditionFn<T>
        whileFn?: string | TWorkflowStepConditionFn<T>
    } {
        const stepId = this.getItemStepId(item)
        const input = (typeof item === 'object' && (item as TWorkflowStepSchemaObj<T, any>).input) as I
        const conditionFn = (typeof item === 'object' && (item as TWorkflowStepSchemaObj<T, any>).condition) as string
        const continueFn = (typeof item === 'object' && (item as TWorkflowControl<T>).continue) as string
        const breakFn = (typeof item === 'object' && (item as TWorkflowControl<T>).break) as string
        const whileFn = (typeof item === 'object' && (item as TSubWorkflowSchemaObj<T>).while) as string
        const steps = (typeof item === 'object' && (item as TSubWorkflowSchemaObj<T>).steps) as TWorkflowSchema<T>
        return {
            stepId, conditionFn, steps, continueFn, breakFn, input, whileFn,
        }
    }

    /**
     * Resume (re-try) interrupted flow
     * @param schemaId 
     * @param state.indexes indexes from flowResult.state.indexes
     * @param state.context context from flowResult.state.context
     * @param input optional - input for interrupted step
     * @returns 
     */
    resume<I>(schemaId: string, state: { indexes: number[], context: T }, input: I): Promise<TFlowOutput<T, unknown>> {
        const schema = this.schemas[schemaId]
        if (!schema) {
            throw new Error(`Workflow schema id "${schemaId}" does not exist.`)
        }
        return this.loopInto({
            schemaId,
            context: state.context,
            indexes: state.indexes,
            schema,
            input,
        })
    }
}
