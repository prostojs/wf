import { TFlowSpyData, TWorkflowStepConditionFn } from './types';

export type TWorkflowSpy<T, I, IR> = (
    event: string,
    eventOutput:
        | string
        | undefined
        | { fn: string | TWorkflowStepConditionFn<T>; result: boolean },
    flowOutput: TFlowSpyData<T, IR>,
    ms?: number,
) => void;
