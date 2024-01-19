import { Workflow, createStep } from './'
import { TWorkflowSpy } from './spy'

let spyLog: string[] = []

const spy: TWorkflowSpy<{ result: number }, unknown, unknown> = (
    event,
    val,
    result,
    ms,
) => {
    let output = ''
    if (typeof val === 'object') {
        const condVal = val as { fn: string; result: boolean }
        if (condVal.fn) {
            output =
                JSON.stringify(condVal.fn) + ' -> ' + String(condVal.result)
        }
    } else {
        output = JSON.stringify(val)
    }
    let _ms = ''
    if (typeof ms === 'number') {
        _ms = `\t~${Math.max(1, ms)}ms`
    }
    spyLog.push(
        `${'  '.repeat(result.state.indexes.length)}${event}: ${output} (result = ${result.state.context?.result})${_ms}`,
    )
}

const steps = [
    createStep<{ result: number }>('add', {
        input: 'number',
        handler: 'ctx.result += input',
    }),
    createStep<{ result: number }>('mul', {
        input: 'number',
        handler: 'ctx.result *= input',
    }),
    createStep<{ result: number }>('div', {
        input: 'number',
        handler: 'ctx.result = ctx.result / input',
    }),
    createStep<{ result: number }>('error', {
        handler:
            'ctx.result < 0 ? new StepRetriableError(new Error("test error")) : undefined',
    }),
    createStep<{ result: number }>('pref/test', {
        handler: 'ctx.result = "prefix worked"',
    }),
]
const flow = new Workflow<{ result: number }, unknown>(steps)
flow.attachSpy(spy)
flow.register('add-mul-div', [
    'add', 'mul', 'div',
])
flow.register('add-mul-div-with-inputs', [
    { id: 'add', input: 5 }, { id: 'mul', input: 2 }, { id: 'div', input: 6 },
])
flow.register('conditional', [
    { id: 'add', input: 5 },
    {
        condition: 'result < 0', steps: [ 'error' ],
    },
    {
        condition: 'result > 10 && result <=50', steps: [
            { id: 'add', input: -10 },
            { id: 'mul', input: 2 },
        ],
    },
    {
        condition: ctx => ctx.result > 50, steps: [
            { id: 'add', input: -25 },
            { id: 'div', input: 4 },
            { steps: [ 'add', 'add' ] },
        ],
    },
    { id: 'mul', input: 1 },
])
flow.register('loop', [
    {
        while: 'result < 10',
        steps: [{ id: 'add', input: 1 }],
    },
    { id: 'mul', input: 10 },
])
flow.register('loop-break', [
    {
        while: 'result < 10',
        steps: [{ id: 'add', input: 1 }, { break: 'result > 5' }],
    },
    { id: 'mul', input: 10 },
])
flow.register('loop-continue', [
    {
        while: 'result < 10',
        steps: [
            { id: 'add', input: 1 },
            { continue: 'result > 5' },
            { id: 'mul', input: 2 },
        ],
    },
    { id: 'mul', input: 10 },
])
flow.register('with-prefix', [
    'test',
], 'pref')
describe('wf', () => {
    beforeEach(() => {
        spyLog = []
    })

    it('must respect local steps prefix', async () => {
        const result = await flow.start('with-prefix', { result: 0 })
        expect(result.finished).toBeTruthy()
        expect(result.state.context.result).toBe('prefix worked')
    })
    it('must run wf with input request', async () => {
        const result = await flow.start('add-mul-div', { result: 1 })
        expect(result.finished).toBeFalsy()
        expect(result.inputRequired)
        expect(result.inputRequired).toEqual('number')
        expect(result.stepId).toEqual('add')
        expect(result.resume).toBeDefined()
        if (result.resume) {
            const add = await result.resume(5)
            expect(add.finished).toBeFalsy()
            expect(add.state.context.result).toBe(6)
            expect(add.inputRequired).toEqual('number')
            expect(add.stepId).toEqual('mul')
            expect(add.resume).toBeDefined()
            if (add.resume) {
                const mul = await add.resume(2)
                expect(mul.finished).toBeFalsy()
                expect(mul.state.context.result).toBe(12)
                expect(mul.inputRequired).toEqual('number')
                expect(mul.stepId).toEqual('div')
                expect(mul.resume).toBeDefined()
                if (mul.resume) {
                    const div = await add.resume(6)
                    expect(div.finished).toBe(true)
                    expect(div.state.context.result).toBe(2)
                    expect(div.inputRequired).not.toBeDefined()
                }
            }
        }
        expect(spyLog).toMatchInlineSnapshot(`
[
  "  workflow-start: "add-mul-div" (result = 1)",
  "  step: "add" (result = 1)	~1ms",
  "  workflow-interrupt: "add-mul-div" (result = 1)",
  "  resume-start: "add-mul-div" (result = 1)",
  "  step: "add" (result = 6)	~1ms",
  "  step: "mul" (result = 6)	~1ms",
  "  resume-interrupt: "add-mul-div" (result = 6)",
  "  resume-start: "add-mul-div" (result = 6)",
  "  step: "mul" (result = 12)	~1ms",
  "  step: "div" (result = 12)	~1ms",
  "  resume-interrupt: "add-mul-div" (result = 12)",
  "  resume-start: "add-mul-div" (result = 12)",
  "  step: "div" (result = 2)	~1ms",
  "  resume-end: "add-mul-div" (result = 2)",
]
`)
    })
    it('must run wf with hardcoded inputs', async () => {
        const result = await flow.start('add-mul-div-with-inputs', { result: 1 })
        expect(result.finished).toBe(true)
        expect(result.state.context.result).toBe(2)
        expect(result.inputRequired).not.toBeDefined()
        expect(spyLog).toMatchInlineSnapshot(`
[
  "  workflow-start: "add-mul-div-with-inputs" (result = 1)",
  "  step: "add" (result = 6)	~1ms",
  "  step: "mul" (result = 12)	~1ms",
  "  step: "div" (result = 2)	~1ms",
  "  workflow-end: "add-mul-div-with-inputs" (result = 2)",
]
`)
    })
    it('must run wf with conditions', async () => {
        const result = await flow.start('conditional', { result: 1 })
        expect(result.finished).toBe(true)
        expect(result.state.context.result).toBe(6)
        const result2 = await flow.start('conditional', { result: 6 })
        expect(result2.finished).toBe(true)
        expect(result2.state.context.result).toBe(2)
        const result3 = await flow.start('conditional', { result: 46 })
        expect(result3.finished).toBeFalsy()
        expect(result3.state.context.result).toBe(6.5)
        expect(result3.inputRequired).toBeDefined()
        expect(result3.resume).toBeDefined()
        if (result3.resume) {
            const result4 = await result3.resume(1.5)
            expect(result4.finished).toBeFalsy()
            expect(result4.state.context.result).toBe(8)
            expect(result4.inputRequired).toBeDefined()
            expect(result4.resume).toBeDefined()
            if (result4.resume) {
                const result5 = await result4.resume(2)
                expect(result5.finished).toBe(true)
                expect(result5.state.context.result).toBe(10)
                expect(result5.inputRequired).not.toBeDefined()
            }
        }
        expect(spyLog).toMatchInlineSnapshot(`
[
  "  workflow-start: "conditional" (result = 1)",
  "  step: "add" (result = 6)	~1ms",
  "  eval-condition-fn: "result < 0" -> false (result = 6)	~1ms",
  "  eval-condition-fn: "result > 10 && result <=50" -> false (result = 6)	~1ms",
  "  eval-condition-fn: undefined -> false (result = 6)	~1ms",
  "  step: "mul" (result = 6)	~1ms",
  "  workflow-end: "conditional" (result = 6)",
  "  workflow-start: "conditional" (result = 6)",
  "  step: "add" (result = 11)	~1ms",
  "  eval-condition-fn: "result < 0" -> false (result = 11)	~1ms",
  "  eval-condition-fn: "result > 10 && result <=50" -> true (result = 11)	~1ms",
  "    subflow-start: "" (result = 11)",
  "    step: "add" (result = 1)	~1ms",
  "    step: "mul" (result = 2)	~1ms",
  "    subflow-end: "" (result = 2)",
  "  eval-condition-fn: undefined -> false (result = 2)	~1ms",
  "  step: "mul" (result = 2)	~1ms",
  "  workflow-end: "conditional" (result = 2)",
  "  workflow-start: "conditional" (result = 46)",
  "  step: "add" (result = 51)	~1ms",
  "  eval-condition-fn: "result < 0" -> false (result = 51)	~1ms",
  "  eval-condition-fn: "result > 10 && result <=50" -> false (result = 51)	~1ms",
  "  eval-condition-fn: undefined -> true (result = 51)	~1ms",
  "    subflow-start: "" (result = 51)",
  "    step: "add" (result = 26)	~1ms",
  "    step: "div" (result = 6.5)	~1ms",
  "      subflow-start: "" (result = 6.5)",
  "      step: "add" (result = 6.5)	~1ms",
  "      subflow-interrupt: "" (result = 6.5)",
  "      subflow-interrupt: "" (result = 6.5)",
  "      workflow-interrupt: "conditional" (result = 6.5)",
  "      resume-start: "conditional" (result = 6.5)",
  "      subflow-start: "" (result = 6.5)",
  "      subflow-start: "" (result = 6.5)",
  "      step: "add" (result = 8)	~1ms",
  "      step: "add" (result = 8)	~1ms",
  "      subflow-interrupt: "" (result = 8)",
  "      subflow-interrupt: "" (result = 8)",
  "      resume-interrupt: "conditional" (result = 8)",
  "      resume-start: "conditional" (result = 8)",
  "      subflow-start: "" (result = 8)",
  "      subflow-start: "" (result = 8)",
  "      step: "add" (result = 10)	~1ms",
  "      subflow-end: "" (result = 10)",
  "    subflow-end: "" (result = 10)",
  "  step: "mul" (result = 10)	~1ms",
  "  resume-end: "conditional" (result = 10)",
]
`)
    })

    it('must run wf with retriable error', async () => {
        const result = await flow.start('conditional', { result: -10 })
        expect(result.finished).toBeFalsy()
        expect(result.state.context.result).toBe(-5)
        expect(result.error).toBeDefined()
        expect(result.retry).toBeDefined()
        if (result.retry) {
            result.state.context.result = 1
            const result2 = await result.retry()
            expect(result2.finished).toBe(true)
            expect(result2.state.context.result).toBe(1)
        }
        expect(spyLog).toMatchInlineSnapshot(`
[
  "  workflow-start: "conditional" (result = -10)",
  "  step: "add" (result = -5)	~1ms",
  "  eval-condition-fn: "result < 0" -> true (result = -5)	~1ms",
  "    subflow-start: "" (result = -5)",
  "    step: "error" (result = -5)	~1ms",
  "    subflow-interrupt: "" (result = -5)",
  "    workflow-interrupt: "conditional" (result = -5)",
  "    resume-start: "conditional" (result = 1)",
  "    subflow-start: "" (result = 1)",
  "    step: "error" (result = 1)	~1ms",
  "    subflow-end: "" (result = 1)",
  "  eval-condition-fn: "result > 10 && result <=50" -> false (result = 1)	~1ms",
  "  eval-condition-fn: undefined -> false (result = 1)	~1ms",
  "  step: "mul" (result = 1)	~1ms",
  "  resume-end: "conditional" (result = 1)",
]
`)
    })
    it('must run wf with loops', async () => {
        const result = await flow.start('loop', { result: 0 })
        expect(result.finished).toBe(true)
        expect(result.state.context.result).toBe(100)
        expect(spyLog).toMatchInlineSnapshot(`
[
  "  workflow-start: "loop" (result = 0)",
  "  eval-while-cond: "result < 10" -> true (result = 0)	~1ms",
  "    subflow-start: "" (result = 0)",
  "    step: "add" (result = 1)	~1ms",
  "    subflow-end: "" (result = 1)",
  "  eval-while-cond: "result < 10" -> true (result = 1)	~1ms",
  "    subflow-start: "" (result = 1)",
  "    step: "add" (result = 2)	~1ms",
  "    subflow-end: "" (result = 2)",
  "  eval-while-cond: "result < 10" -> true (result = 2)	~1ms",
  "    subflow-start: "" (result = 2)",
  "    step: "add" (result = 3)	~1ms",
  "    subflow-end: "" (result = 3)",
  "  eval-while-cond: "result < 10" -> true (result = 3)	~1ms",
  "    subflow-start: "" (result = 3)",
  "    step: "add" (result = 4)	~1ms",
  "    subflow-end: "" (result = 4)",
  "  eval-while-cond: "result < 10" -> true (result = 4)	~1ms",
  "    subflow-start: "" (result = 4)",
  "    step: "add" (result = 5)	~1ms",
  "    subflow-end: "" (result = 5)",
  "  eval-while-cond: "result < 10" -> true (result = 5)	~1ms",
  "    subflow-start: "" (result = 5)",
  "    step: "add" (result = 6)	~1ms",
  "    subflow-end: "" (result = 6)",
  "  eval-while-cond: "result < 10" -> true (result = 6)	~1ms",
  "    subflow-start: "" (result = 6)",
  "    step: "add" (result = 7)	~1ms",
  "    subflow-end: "" (result = 7)",
  "  eval-while-cond: "result < 10" -> true (result = 7)	~1ms",
  "    subflow-start: "" (result = 7)",
  "    step: "add" (result = 8)	~1ms",
  "    subflow-end: "" (result = 8)",
  "  eval-while-cond: "result < 10" -> true (result = 8)	~1ms",
  "    subflow-start: "" (result = 8)",
  "    step: "add" (result = 9)	~1ms",
  "    subflow-end: "" (result = 9)",
  "  eval-while-cond: "result < 10" -> true (result = 9)	~1ms",
  "    subflow-start: "" (result = 9)",
  "    step: "add" (result = 10)	~1ms",
  "    subflow-end: "" (result = 10)",
  "  eval-while-cond: "result < 10" -> false (result = 10)	~1ms",
  "  step: "mul" (result = 100)	~1ms",
  "  workflow-end: "loop" (result = 100)",
]
`)
    })
    it('must run wf with loops and break', async () => {
        const result = await flow.start('loop-break', { result: 0 })
        expect(result.finished).toBe(true)
        expect(result.state.context.result).toBe(60)
        expect(spyLog).toMatchInlineSnapshot(`
[
  "  workflow-start: "loop-break" (result = 0)",
  "  eval-while-cond: "result < 10" -> true (result = 0)	~1ms",
  "    subflow-start: "" (result = 0)",
  "    step: "add" (result = 1)	~1ms",
  "    eval-break-fn: "result > 5" -> false (result = 1)	~1ms",
  "    subflow-end: "" (result = 1)",
  "  eval-while-cond: "result < 10" -> true (result = 1)	~1ms",
  "    subflow-start: "" (result = 1)",
  "    step: "add" (result = 2)	~1ms",
  "    eval-break-fn: "result > 5" -> false (result = 2)	~1ms",
  "    subflow-end: "" (result = 2)",
  "  eval-while-cond: "result < 10" -> true (result = 2)	~1ms",
  "    subflow-start: "" (result = 2)",
  "    step: "add" (result = 3)	~1ms",
  "    eval-break-fn: "result > 5" -> false (result = 3)	~1ms",
  "    subflow-end: "" (result = 3)",
  "  eval-while-cond: "result < 10" -> true (result = 3)	~1ms",
  "    subflow-start: "" (result = 3)",
  "    step: "add" (result = 4)	~1ms",
  "    eval-break-fn: "result > 5" -> false (result = 4)	~1ms",
  "    subflow-end: "" (result = 4)",
  "  eval-while-cond: "result < 10" -> true (result = 4)	~1ms",
  "    subflow-start: "" (result = 4)",
  "    step: "add" (result = 5)	~1ms",
  "    eval-break-fn: "result > 5" -> false (result = 5)	~1ms",
  "    subflow-end: "" (result = 5)",
  "  eval-while-cond: "result < 10" -> true (result = 5)	~1ms",
  "    subflow-start: "" (result = 5)",
  "    step: "add" (result = 6)	~1ms",
  "    eval-break-fn: "result > 5" -> true (result = 6)	~1ms",
  "    subflow-end: "" (result = 6)",
  "  step: "mul" (result = 60)	~1ms",
  "  workflow-end: "loop-break" (result = 60)",
]
`)
    })
    it('must run wf with loops and continue', async () => {
        const result = await flow.start('loop-continue', { result: 0 })
        expect(result.finished).toBe(true)
        expect(result.state.context.result).toBe(100)
        expect(spyLog).toMatchInlineSnapshot(`
[
  "  workflow-start: "loop-continue" (result = 0)",
  "  eval-while-cond: "result < 10" -> true (result = 0)	~1ms",
  "    subflow-start: "" (result = 0)",
  "    step: "add" (result = 1)	~1ms",
  "    eval-continue-fn: "result > 5" -> false (result = 1)	~1ms",
  "    step: "mul" (result = 2)	~1ms",
  "    subflow-end: "" (result = 2)",
  "  eval-while-cond: "result < 10" -> true (result = 2)	~1ms",
  "    subflow-start: "" (result = 2)",
  "    step: "add" (result = 3)	~1ms",
  "    eval-continue-fn: "result > 5" -> false (result = 3)	~1ms",
  "    step: "mul" (result = 6)	~1ms",
  "    subflow-end: "" (result = 6)",
  "  eval-while-cond: "result < 10" -> true (result = 6)	~1ms",
  "    subflow-start: "" (result = 6)",
  "    step: "add" (result = 7)	~1ms",
  "    eval-continue-fn: "result > 5" -> true (result = 7)	~1ms",
  "    subflow-end: "" (result = 7)",
  "  eval-while-cond: "result < 10" -> true (result = 7)	~1ms",
  "    subflow-start: "" (result = 7)",
  "    step: "add" (result = 8)	~1ms",
  "    eval-continue-fn: "result > 5" -> true (result = 8)	~1ms",
  "    subflow-end: "" (result = 8)",
  "  eval-while-cond: "result < 10" -> true (result = 8)	~1ms",
  "    subflow-start: "" (result = 8)",
  "    step: "add" (result = 9)	~1ms",
  "    eval-continue-fn: "result > 5" -> true (result = 9)	~1ms",
  "    subflow-end: "" (result = 9)",
  "  eval-while-cond: "result < 10" -> true (result = 9)	~1ms",
  "    subflow-start: "" (result = 9)",
  "    step: "add" (result = 10)	~1ms",
  "    eval-continue-fn: "result > 5" -> true (result = 10)	~1ms",
  "    subflow-end: "" (result = 10)",
  "  eval-while-cond: "result < 10" -> false (result = 10)	~1ms",
  "  step: "mul" (result = 100)	~1ms",
  "  workflow-end: "loop-continue" (result = 100)",
]
`)
    })

    afterEach(() => {
        console.log(spyLog.join('\n'))
    })
})
