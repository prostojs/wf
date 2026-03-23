export type TStepOutput<IR> = void | {
    inputRequired: IR;
    expires?: number;
    errorList?: unknown;
};
export type TStepHandler<T, I, IR> = (
    ctx: T,
    input: I,
) =>
    | TStepOutput<IR>
    | StepRetriableError<IR>
    | Promise<TStepOutput<IR> | StepRetriableError<IR>>;

export interface TFlowState<T> {
    schemaId: string;
    context: T;
    indexes: number[];
}

export interface TFlowSpyData<T, IR> {
    state: TFlowState<T>;
    finished: boolean;
    stepId: string;
    inputRequired?: IR;
    interrupt?: boolean;
    error?: Error;
    expires?: number;
    errorList?: unknown;
}

export interface TFlowFinished<T, IR> {
    finished: true;
    state: TFlowState<T>;
    stepId: string;
    resume?: never;
    retry?: never;
    error?: never;
    inputRequired?: never;
    expires?: never;
    errorList?: never;
}

export interface TFlowPaused<T, I, IR> {
    finished: false;
    state: TFlowState<T>;
    stepId: string;
    inputRequired: IR;
    resume: (input: I) => Promise<TFlowOutput<T, unknown, IR>>;
    expires?: number;
    errorList?: unknown;
    error?: never;
    retry?: never;
}

export interface TFlowFailed<T, I, IR> {
    finished: false;
    state: TFlowState<T>;
    stepId: string;
    error: Error;
    retry: (input?: I) => Promise<TFlowOutput<T, unknown, IR>>;
    inputRequired?: IR;
    expires?: number;
    errorList?: unknown;
    resume?: never;
}

export type TFlowOutput<T, I, IR> =
    | TFlowFinished<T, IR>
    | TFlowPaused<T, I, IR>
    | TFlowFailed<T, I, IR>;

export type TWorkflowStepConditionFn<T> = (
    ctx: T,
) => boolean | Promise<boolean>;

export interface TWorkflowStepSchemaObj<T, I> {
    condition?: string | TWorkflowStepConditionFn<T>;
    id: string;
    input?: I;
    steps?: never;
}
export interface TSubWorkflowSchemaObj<T> {
    condition?: string | TWorkflowStepConditionFn<T>;
    while?: string | TWorkflowStepConditionFn<T>;
    steps: TWorkflowSchema<T>;
    id?: never;
}
export type TWorkflowControl<T> =
    | { continue: string | TWorkflowStepConditionFn<T>; break?: never }
    | { break: string | TWorkflowStepConditionFn<T>; continue?: never };

export type TWorkflowItem<T> =
    | TWorkflowStepSchemaObj<T, any>
    | TSubWorkflowSchemaObj<T>
    | TWorkflowControl<T>
    | string;

export type TWorkflowSchema<T> = TWorkflowItem<T>[];

export class StepRetriableError<IR> extends Error {
    name = 'StepRetriableError';

    constructor(
        public readonly originalError: Error,
        public errorList?: unknown,
        public readonly inputRequired?: IR,
        public expires?: number,
    ) {
        super(originalError.message);
    }
}
