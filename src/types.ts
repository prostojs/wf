/* eslint-disable @typescript-eslint/no-explicit-any */
export type TStepOutput<IR> = void | { inputRequired: IR, expires?: number, errorList?: unknown }
export type TStepHandler<T, I, IR> = ((ctx: T, input: I) => TStepOutput<IR> | StepRetriableError<IR> | Promise<TStepOutput<IR> | StepRetriableError<IR>>)

export interface TFlowOutput<T, I, IR> {
    state: {
        schemaId: string
        context: T
        indexes: number[]
    },
    finished: boolean
    inputRequired?: IR
    interrupt?: boolean
    break?: boolean
    stepId: string
    resume?: ((input: I) => Promise<TFlowOutput<T, unknown, IR>>)
    retry?: ((input?: I) => Promise<TFlowOutput<T, unknown, IR>>)
    error?: Error
    expires?: number
    errorList?: unknown
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

export class StepRetriableError<IR> extends Error {
    name = 'StepRetriableError'

    constructor(
        public readonly originalError: Error,
        public errorList?: unknown,
        public readonly inputRequired?: IR,
        public expires?: number,
    ) {
        super(originalError.message)
    }
}
