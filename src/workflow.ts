/* eslint-disable @typescript-eslint/no-explicit-any */
import { TFlowOutput, TWorkflowItem, TWorkflowSchema, TWorkflowStepConditionFn, StepRetriableError } from './types'
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

    protected conditions: Record<symbol, TWorkflowStepConditionFn<T>> = {}

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
        if (typeof item === 'string') {
            if (!this.mappedSteps[item])  error(item)
        } else if (typeof item.id === 'string') {
            if (!this.mappedSteps[item.id]) error(item.id)
        } else {
            for (const step of item.steps) {
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
                const item = schema[i]
                if (!skipCondition && typeof item === 'object' && item.condition) {
                    if (typeof item.condition === 'string') {
                        const symbol = Symbol.for(item.condition)
                        if (!this.conditions[symbol]) {
                            this.conditions[symbol] = generateFn<Promise<boolean>>(item.condition) as TWorkflowStepConditionFn<T>
                        }
                        if (!(await this.conditions[symbol](result.state.context))) continue
                    } else {
                        if (!(await item.condition(result.state.context))) continue
                    }
                }
                skipCondition = false
                if (typeof item === 'string' || typeof item.id === 'string') {
                    const stepId = typeof item === 'string' ? item : item.id
                    result.stepId = stepId
                    const step = this.resolveStep(stepId)
                    if (!step) {
                        throw new Error(`Step "${stepId}" not found.`)
                    }
                    let mergedInput = input
                    if (typeof item === 'object' && typeof item.input !== 'undefined') {
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
                    result = await this.loopInto({
                        schemaId: opts.schemaId,
                        schema: item.steps,
                        context: result.state.context,
                        indexes,
                        input,
                        level: level + 1,
                    })
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
