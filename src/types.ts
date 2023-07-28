/* eslint-disable @typescript-eslint/no-explicit-any */
export type TStepOutput = void | { inputRequired: unknown }
export type TStepHandler<T, I, D> = ((ctx: T, input: I) => TStepOutput | StepRetriableError<D> | Promise<TStepOutput | StepRetriableError<D>>)

export interface TFlowOutput<T, I> {
    schemaId: string
    state: {
        context: T
        indexes: number[]
    },
    finished: boolean
    inputRequired?: unknown
    interrupt?: boolean
    stepId: string
    resume?: ((input: I) => Promise<TFlowOutput<T, unknown>>)
    retry?: ((input?: I) => Promise<TFlowOutput<T, unknown>>)
    error?: Error
}

export type TWorkflowStepConditionFn<T> = ((ctx: T) => boolean | Promise<boolean>)

export interface TWorkflowStepSchemaObj<T, I> {
    condition?: string | TWorkflowStepConditionFn<T>
    id: string
    input?: I
    steps?: never
}
export interface TSubWorkflowSchemaObj<T> {
    condition?: string | TWorkflowStepConditionFn<T>
    steps: TWorkflowSchema<T>
    id?: never
}
export type TWorkflowItem<T> = TWorkflowStepSchemaObj<T, any> | TSubWorkflowSchemaObj<T> | string

export type TWorkflowSchema<T> = TWorkflowItem<T>[]

export class StepRetriableError<D> extends Error {
    constructor(public readonly originalError: Error, public readonly inputRequired?: D) {
        super(originalError.message)
    }
}
