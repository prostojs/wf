import { Workflow, createStep } from './'

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
        handler: 'ctx.result < 0 ? new StepRetriableError(new Error("test error")) : undefined',
    }),
]
const flow = new Workflow<{ result: number }>(steps)
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
        steps: [{ id: 'add', input: 1 }, { continue: 'result > 5' }, { id: 'mul', input: 2 }],
    },
    { id: 'mul', input: 10 },
])
describe('wf', () => {
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
    })
    it('must run wf with hardcoded inputs', async () => {
        const result = await flow.start('add-mul-div-with-inputs', { result: 1 })
        expect(result.finished).toBe(true)
        expect(result.state.context.result).toBe(2)
        expect(result.inputRequired).not.toBeDefined()
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
    })
    it('must run wf with loops', async () => {
        const result = await flow.start('loop', { result: 0 })
        expect(result.finished).toBe(true)
        expect(result.state.context.result).toBe(100)
    })
    it('must run wf with loops and continue', async () => {
        const result = await flow.start('loop-continue', { result: 0 })
        expect(result.finished).toBe(true)
        expect(result.state.context.result).toBe(100)
    })
})
