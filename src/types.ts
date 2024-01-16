/* eslint-disable @typescript-eslint/no-explicit-any */
export type TStepOutput = void | { inputRequired: unknown, expires?: number, errorList?: unknown[] }
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
    break?: boolean
    stepId: string
    resume?: ((input: I) => Promise<TFlowOutput<T, unknown>>)
    retry?: ((input?: I) => Promise<TFlowOutput<T, unknown>>)
    error?: Error
    expires?: number
    errorList?: unknown[]
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
    while?: string | TWorkflowStepConditionFn<T>
    steps: TWorkflowSchema<T>
    id?: never
}
export type TWorkflowControl<T> = { continue: string | TWorkflowStepConditionFn<T>, break?: never } | { break: string | TWorkflowStepConditionFn<T>, continue?: never  }

export type TWorkflowItem<T> = TWorkflowStepSchemaObj<T, any> | TSubWorkflowSchemaObj<T> | TWorkflowControl<T> | string

export type TWorkflowSchema<T> = TWorkflowItem<T>[]

export class StepRetriableError<D> extends Error {
    name = 'StepRetriableError'

    constructor(
        public readonly originalError: Error,
        public errorList?: unknown[],
        public readonly inputRequired?: D,
        public expires?: number,
    ) {
        super(originalError.message)
    }
}
