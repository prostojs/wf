import { TFlowOutput, TWorkflowStepConditionFn } from './types'

export type TWorkflowSpy<T, I> = ((
    event: string,
    eventOutput: string | undefined | { fn: string | TWorkflowStepConditionFn<T>, result: boolean },
    flowOutput: TFlowOutput<T, I>,
    ms?: number
) => void)
