/* eslint-disable @typescript-eslint/no-explicit-any */
import { TFlowOutput, TWorkflowItem, TWorkflowSchema, TWorkflowStepConditionFn, StepRetriableError, TSubWorkflowSchemaObj, TWorkflowStepSchemaObj, TWorkflowControl } from './types'
import { Step } from './step'
import { FtringsPool } from '@prostojs/ftring'
import { TWorkflowSpy } from './spy'

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
export class Workflow<T, IR> {
    protected mappedSteps: Record<string, Step<T, any, IR>> = {}

    protected schemas: Record<string, TWorkflowSchema<T>> = {}

    protected schemaPrefix: Record<string, string> = {}

    protected spies: TWorkflowSpy<T, any, IR>[] = []

    protected fnPool = new FtringsPool<Promise<boolean>, unknown>()

    constructor(protected steps: Step<T, any, IR>[]) {
        for (const step of steps) {
            if (this.mappedSteps[step.id]) {
                throw new Error(`Duplicate step id "${step.id}"`)
            }
            this.mappedSteps[step.id] = step
        }
    }

    protected resolveStep(stepId: string) {
        return this.mappedSteps[stepId]
    }

    public attachSpy<I = any>(fn: TWorkflowSpy<T, I, IR>) {
        this.spies.push(fn)
        return () => this.detachSpy(fn)
    }

    public detachSpy<I = any>(fn: TWorkflowSpy<T, I, IR>) {
        this.spies = this.spies.filter((spy) => spy !== fn)
    }

    public addStep<I>(step: Step<T, I, IR>) {
        if (this.mappedSteps[step.id]) {
            throw new Error(`Duplicate step id "${step.id}"`)
        }
        this.steps.push(step)
        this.mappedSteps[step.id] = step
    }

    protected emit(
        spy: TWorkflowSpy<T, any, IR> | undefined,
        event: string,
        eventOutput:
            | string
            | undefined
            | { fn: string | TWorkflowStepConditionFn<T>; result: boolean },
        flowOutput: TFlowOutput<T, any, IR>,
        ms?: number,
    ) {
        runSpy(spy)
        for (const spy of this.spies) {
            runSpy(spy)
        }
        function runSpy(spy: TWorkflowSpy<T, any, IR> | undefined) {
            if (spy) {
                try {
                    spy(event, eventOutput, flowOutput, ms)
                } catch (e) {
                    console.error(
                        (e as Error).message ||
                            'Workflow spy uncought exception.',
                        (e as Error).stack,
                    )
                }
            }
        }
    }

    /**
     * Validate that schema refers only to existing step IDs
     * @param schemaId
     * @param item
     */
    protected validateSchema(
        schemaId: string,
        item: TWorkflowItem<T>,
        prefix?: string,
    ) {
        const { stepId, steps } = this.normalizeWorkflowItem(item, prefix)
        if (typeof stepId === 'string') {
            if (!this.resolveStep(stepId)) error(stepId)
        } else if (steps) {
            for (const step of steps) {
                this.validateSchema(schemaId, step, prefix)
            }
        }
        function error(id: string) {
            throw new Error(
                `Workflow schema "${schemaId}" refers to an unknown step id "${id}".`,
            )
        }
    }

    /**
     * Register flow (sequence of steps) under ID
     * @param id
     * @param schema
     * @param prefix adds to steps that not starting from '/'
     */
    register(id: string, schema: TWorkflowSchema<T>, prefix?: string) {
        if (!this.schemas[id]) {
            for (const step of schema) {
                this.validateSchema(id, step, prefix)
            }
            this.schemas[id] = schema
            if (prefix) {
                this.schemaPrefix[id] = prefix
            }
        } else {
            throw new Error(
                `Workflow schema with id "${id}" already registered.`,
            )
        }
    }

    /**
     * Start flow by ID
     * @param schemaId
     * @param initialContext initial context
     * @param input initial input (for the first step if required)
     * @returns
     */
    start<I>(
        schemaId: string,
        initialContext: T,
        input?: I,
        spy?: TWorkflowSpy<T, I, IR>,
    ): Promise<TFlowOutput<T, I, IR>> {
        const schema = this.schemas[schemaId]
        if (!schema) {
            throw new Error(`Workflow schema id "${schemaId}" does not exist.`)
        }
        return this.loopInto('workflow', {
            schemaId,
            context: initialContext,
            schema,
            input,
            spy,
        })
    }

    protected async callConditionFn(
        spy: TWorkflowSpy<T, any, IR> | undefined,
        event: string,
        fn: string | TWorkflowStepConditionFn<T>,
        result: TFlowOutput<T, unknown, IR>,
    ): Promise<boolean> {
        let conditionResult = false
        const now = new Date().getTime()
        if (typeof fn === 'string') {
            conditionResult = await this.fnPool.call(fn, result.state.context)
        } else {
            conditionResult = await fn(result.state.context)
        }
        this.emit(
            spy,
            event,
            { fn, result: conditionResult },
            result,
            new Date().getTime() - now,
        )
        return conditionResult
    }

    protected async loopInto<I>(
        event: string,
        opts: {
            schemaId: string;
            schema: TWorkflowSchema<T>;
            context: T;
            input?: I;
            indexes?: number[];
            level?: number;
            spy?: TWorkflowSpy<T, I, IR>;
        },
    ): Promise<TFlowOutput<T, unknown, IR>> {
        const prefix = this.schemaPrefix[opts.schemaId]
        const schema = opts.schema
        const level = opts.level || 0
        const indexes = (opts.indexes = opts.indexes || [])
        const startIndex = indexes[level] || 0
        let skipCondition = indexes.length > level + 1 // skip condition when re-try (resume)
        indexes[level] = startIndex
        let input = opts.input
        let result: TFlowOutput<T, unknown, IR> = {
            state: { schemaId: opts.schemaId, context: opts.context, indexes },
            finished: false,
            stepId: '',
        }
        this.emit(
            opts.spy,
            event + '-start',
            event === 'subflow' ? '' : opts.schemaId,
            result,
        )
        try {
            for (let i = startIndex; i < schema.length; i++) {
                indexes[level] = i
                const item = this.normalizeWorkflowItem(schema[i], prefix)
                if (item.continueFn) {
                    if (
                        await this.callConditionFn(
                            opts.spy,
                            'eval-continue-fn',
                            item.continueFn,
                            result,
                        )
                    ) {
                        result.break = false
                        break
                    }
                }
                if (item.breakFn) {
                    if (
                        await this.callConditionFn(
                            opts.spy,
                            'eval-break-fn',
                            item.breakFn,
                            result,
                        )
                    ) {
                        result.break = true
                        break
                    }
                }
                if (!skipCondition && item.conditionFn) {
                    if (
                        !(await this.callConditionFn(
                            opts.spy,
                            'eval-condition-fn',
                            item.conditionFn,
                            result,
                        ))
                    )
                        continue
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
                        } else if (
                            typeof item.input === 'object' &&
                            typeof input === 'object'
                        ) {
                            mergedInput = { ...item.input, ...input } as I
                        }
                    }
                    const now = new Date().getTime()
                    const stepResult = await step.handle(
                        result.state.context,
                        mergedInput,
                    )
                    const ms = new Date().getTime() - now
                    if (stepResult && stepResult.inputRequired) {
                        result.interrupt = true
                        result.inputRequired = stepResult.inputRequired
                        result.expires = stepResult.expires
                        result.errorList = stepResult.errorList
                        this.emit(opts.spy, 'step', item.stepId, result, ms)
                        break
                    }
                    if (
                        stepResult &&
                        stepResult instanceof StepRetriableError
                    ) {
                        retriableError(stepResult)
                        this.emit(opts.spy, 'step', item.stepId, result, ms)
                        break
                    }
                    this.emit(opts.spy, 'step', item.stepId, result, ms)
                } else if (item.steps) {
                    while (true) {
                        if (item.whileFn) {
                            if (
                                !(await this.callConditionFn(
                                    opts.spy,
                                    'eval-while-cond',
                                    item.whileFn,
                                    result,
                                ))
                            )
                                break
                        }
                        result = await this.loopInto('subflow', {
                            schemaId: opts.schemaId,
                            schema: item.steps,
                            context: result.state.context,
                            indexes,
                            input,
                            level: level + 1,
                            spy: opts.spy,
                        })
                        if (!item.whileFn || result.break || result.interrupt)
                            break
                    }
                    result.break = false
                    if (result.interrupt) break
                }
                input = undefined
            }
        } catch (e) {
            if (e instanceof StepRetriableError) {
                retriableError(e as StepRetriableError<IR>)
            } else {
                this.emit(
                    opts.spy,
                    'error:',
                    (e as Error).message || '',
                    result,
                )
                throw e
            }
        }
        function retriableError(e: StepRetriableError<IR>) {
            result.interrupt = true
            result.error = e.originalError
            result.inputRequired = e.inputRequired
            result.errorList = e.errorList
            result.expires = e.expires
        }
        if (result.interrupt) {
            if (level === 0) {
                const resume = (input: unknown) =>
                    this.resume(result.state, input, opts.spy)
                if (result.error) {
                    result.retry = resume
                } else {
                    result.resume = resume
                }
            }
            this.emit(
                opts.spy,
                event + '-interrupt',
                event === 'subflow' ? '' : opts.schemaId,
                result,
            )
            return result
        }
        if (level === 0) {
            result.finished = true
        }
        this.emit(
            opts.spy,
            event + '-end',
            event === 'subflow' ? '' : opts.schemaId,
            result,
        )
        indexes.pop()
        return result
    }

    protected prefixStepId(id: string, prefix?: string) {
        if (!id) return id
        return prefix && id[0] !== '/' ? [prefix, id].join('/') : id
    }

    protected getItemStepId<T>(
        item: TWorkflowItem<T>,
        prefix?: string,
    ): string | undefined {
        return this.prefixStepId(typeof item === 'string'
            ? item
            : (item as TWorkflowStepSchemaObj<T, any>).id, prefix)
    }

    protected normalizeWorkflowItem<T, I>(
        item: TWorkflowItem<T>,
        prefix?: string,
    ): {
        stepId?: string;
        input?: I;
        steps?: TWorkflowSchema<T>;
        conditionFn?: string | TWorkflowStepConditionFn<T>;
        continueFn?: string | TWorkflowStepConditionFn<T>;
        breakFn?: string | TWorkflowStepConditionFn<T>;
        whileFn?: string | TWorkflowStepConditionFn<T>;
    } {
        const stepId = this.getItemStepId(item, prefix)
        const input =
            typeof item === 'object'
                ? ((item as TWorkflowStepSchemaObj<T, any>).input as I)
                : undefined
        const conditionFn = (typeof item === 'object' &&
            (item as TWorkflowStepSchemaObj<T, any>).condition) as string
        const continueFn = (typeof item === 'object' &&
            (item as TWorkflowControl<T>).continue) as string
        const breakFn = (typeof item === 'object' &&
            (item as TWorkflowControl<T>).break) as string
        const whileFn = (typeof item === 'object' &&
            (item as TSubWorkflowSchemaObj<T>).while) as string
        const steps = (typeof item === 'object' &&
            (item as TSubWorkflowSchemaObj<T>).steps) as TWorkflowSchema<T>
        return {
            stepId,
            conditionFn,
            steps,
            continueFn,
            breakFn,
            input,
            whileFn,
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
    resume<I>(
        state: TFlowOutput<T, I, IR>['state'],
        input: I,
        spy?: TWorkflowSpy<T, I, IR>,
    ): Promise<TFlowOutput<T, unknown, IR>> {
        const schema = this.schemas[state.schemaId]
        if (!schema) {
            throw new Error(`Workflow schema id "${state.schemaId}" does not exist.`)
        }
        return this.loopInto('resume', {
            schemaId: state.schemaId,
            context: state.context,
            indexes: state.indexes,
            schema,
            input,
            spy,
        })
    }
}
