import { TFlowOutput, TWorkflowStepConditionFn } from './types'

export type TWorkflowSpy<T, I, IR> = ((
    event: string,
    eventOutput: string | undefined | { fn: string | TWorkflowStepConditionFn<T>, result: boolean },
    flowOutput: TFlowOutput<T, I, IR>,
    ms?: number
) => void)
