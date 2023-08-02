# @prostojs/wf

Generic workflow framework

## What is it?

`@prostojs/wf` is designed to manage workflows as sequences of tasks (steps). It is a comprehensive solution for scenarios where tasks need to be executed in a particular sequence with the ability to handle errors, resume from saved states, and incorporate decision making based on previous results. It interrupts workflow when interaction with user/system is needed and can be resumed when new inputs are available.

One of the defining features of this library is its support for "resume/retry" workflows from saved states. To support this, the workflow state can be serialized and stored. Moreover, step handlers can be written as text and stored in a database.

## Why Use @prostojs/wf?

In complex systems, there are often tasks that depend on the successful completion of previous tasks. Handling these dependencies manually can become cumbersome and error-prone. `@prostojs/wf` provides a clean, structured, and reliable way of defining and executing such tasks. It provides powerful constructs to express complex workflows in a simple and clear manner.

In addition, the support for resuming workflows from saved states is particularly useful in scenarios where tasks can fail and need to be retried, or where additional inputs may be required during execution.

## Installation

To install `@prostojs/wf`, you can use npm:

```bash
npm install @prostojs/wf
```

## Quick Start Guide

Here is a quick example of how to use `@prostojs/wf`:

```ts
import { Workflow, createStep } from '@prostojs/wf';

// Define steps
const steps = [
    createStep('add', {
        input: 'number',
        handler: 'ctx.result += input',
    }),
    createStep('mul', {
        input: 'number',
        handler: 'ctx.result *= input',
    }),
    createStep('div', {
        input: 'number',
        handler: 'ctx.result = ctx.result / input',
    }),
    createStep('error', {
        handler: 'ctx.result < 0 ? new StepRetriableError(new Error("test error")) : undefined',
    }),
];

// Create a workflow
const flow = new Workflow<{ result: number }>(steps);

// Register a sequence of steps
flow.register('add-mul-div', [
    'add', 'mul', 'div',
]);

// Start a workflow
const result = await flow.start('add-mul-div', { result: 1 });
```

## Documentation and Usage Examples

`@prostojs/wf` has several main constructs:

### Step

A Step represents a unit of work in a workflow. You can define a Step by providing an id and a handler function. The handler function contains the logic to be performed in the step. 

```ts
import { Step } from '@prostojs/wf';

const step = new Step('step1', (ctx, input) => {
    ctx.stepData = 'completed';
    console.log('Step completed');
});
```

### Workflow

A Workflow is a container for a series of steps. A Workflow is defined by providing a list of steps. Workflows can be started, and can also register sequences of steps. 

```ts
import { Workflow, createStep } from '@prostojs/wf';

const steps = [
    createStep('step1', {
        input: 'number',
        handler: 'ctx.result += input',
    }),
    // More steps...
];

const flow = new Workflow(steps);
```

### Registering Flows

A flow, which is a sequence of steps, can be registered to a Workflow under a particular ID.

```ts
flow.register('sequence1', [
    'step1',
    'step2',
    // More steps...
]);
```

### Starting Workflows

A registered workflow can be started by providing the registered ID and an initial context:

```ts
const result = await flow.start('sequence1', { result: 1 });
```

### Resume/Retry Workflows

If a workflow gets interrupted due to an error or a requirement for additional input, it can be resumed using the saved state:

```ts
const result = await flow.resume('sequence1', savedState, additionalInput);
```

## Deep dive in FLows

A workflow schema in the context of this framework defines the sequence of steps that a workflow will execute, as well as conditions that determine whether certain steps or subflows should be executed. Each step in a workflow can have a pre-condition, and if this condition resolves to a falsy value, the step is skipped. Furthermore, a step can also represent a subflow, which is a group of steps, and this subflow can also have a pre-condition. If the pre-condition of a subflow resolves to a falsy value, all the steps in the subflow are skipped.

**Example 1: Online Order Processing**

```ts
const orderSteps = [
    createStep('checkInventory', {/* configuration */}),
    createStep('processPayment', {/* configuration */}),
    createStep('packItem', {/* configuration */}),
    createStep('shipItem', {/* configuration */}),
];

const orderFlow = new Workflow(orderSteps);

orderFlow.register('onlineOrder', [
    'checkInventory',
    {
        id: 'processPayment',
        condition: 'order.totalPrice > 0', // Skip if the item is free
    },
    {
        condition: 'order.itemType != "digital"', // Skip if the item is a digital product
        steps: ['packItem', 'shipItem'],
    },
]);
```

**Example 2: User Registration**

```ts
const registrationSteps = [
    createStep('validateEmail', {/* configuration */}),
    createStep('sendConfirmationEmail', {/* configuration */}),
    createStep('verifyConfirmation', {/* configuration */}),
    createStep('createAccount', {/* configuration */}),
    createStep('sendWelcomeEmail', {/* configuration */}),
];

const registrationFlow = new Workflow(registrationSteps);

registrationFlow.register('userRegistration', [
    {
        id: 'validateEmail',
        condition: 'sitePolicy.requiresEmailVerification', // Skip if email verification is not required
    },
    {
        id: 'sendConfirmationEmail',
        condition: 'sitePolicy.requiresEmailVerification', // Skip if email verification is not required
    },
    {
        id: 'verifyConfirmation',
        condition: 'sitePolicy.requiresEmailVerification', // Skip if email verification is not required
    },
    'createAccount',
    {
        id: 'sendWelcomeEmail',
        condition: 'user.emailPreferences.receiveEmails', // Skip if user opts out of emails
    },
]);
```

## Example 3: User Authentication Workflow

Our scenario involves a user authentication system, which includes both login and multi-factor authentication (MFA) processes.

### Defining Steps

We first define the steps that will be involved in our user authentication system:

1. `login`: This step requires user input (username and password).
2. `generate-mfa`: This step creates the MFA token for the user.
3. `send-mfa`: This step sends the MFA token to the user.
4. `input-mfa`: This step requires user input (MFA code).

We can define these steps as follows:

```ts
const steps = [
    createStep<{ username: string, password: string }>('login', {
        input: loginInputs,
        async handler(ctx, input) {
            // Login process
        },
    }),
    createStep('generate-mfa', {
        /* configuration */
    }),
    createStep('send-mfa', {
        /* configuration */
    }),
    createStep<{ mfaCode: string }>('input-mfa', {
        input: mfaInputs,
        async handler(ctx, input) {
            // MFA verification process
        },
    }),
];

export const AuthFlow = new Workflow(steps);
```

The `createStep` function defines a workflow step. It expects a step ID, an optional input, and a handler function.

### Defining Workflow

We can now define our `login` workflow, which includes an MFA process if enabled for the user:

```ts
AuthFlow.register('login', [
    'login',
    {
        condition: '(async () => (await user.read()).mfa.enabled)()',
        steps: [
            'generate-mfa',
            'send-mfa',
            'input-mfa',
        ],
    },
]);
```

### User Inputs

For user inputs, we need to define metadata that specifies what inputs are required:

```ts
const loginInputs: TAuthInputMetadata[] = [
    {
        name: 'username',
        label: 'Username (Email)',
        type: 'string',
        required: true,
    }, {
        name: 'password',
        label: 'Password',
        type: 'password',
        required: true,
    },
]

const mfaInputs: TAuthInputMetadata[] = [
    {
        name: 'mfaCode',
        label: 'Code',
        type: 'pin',
        required: true,
    },
]
```

These metadata are associated with the corresponding steps as their `input` property when the steps are created. When a step is run without the required inputs, it will be interrupted, and the `inputRequired` property of the result will contain the required inputs.

### Running the Workflow

When a user attempts to login, we start the `login` workflow:

```ts
// initiate the flow
const result = await AuthFlow.start('login', {})
if (!result.finished) {
 // respond with result.inputRequired that contains array `loginInputs`
 // save result.state somewhere (can be db, can be encrypted in token)
}
```

If the workflow is not finished, i.e., it needs user input, we save the workflow state and send the required input fields (`result.inputRequired`) to the frontend for the user to fill in. 

Once we receive the required inputs from the user, we can resume the workflow:

```ts
// resuming flow when get inputs from user
await AuthFlow.resume('login', result.state, input) // where input is { username, password } from user
```
## While Loops in Workflows

Suppose we're building an email campaign that retries sending emails to users until a successful delivery or a predefined limit is reached.

```ts
flow.register('emailRetry', [
    {
        while: 'attempts < 5 && !emailSent',
        steps: [{ id: 'sendEmail', input: 'user@email.com' }, { id: 'increaseAttempts' }],
    },
    { id: 'logFailure', condition: '!emailSent' },
])
```

In this example, the workflow will keep trying to send an email to a user up to 5 times. After 5 attempts or a successful email delivery, it will break out of the loop. If the email isn't sent successfully after all attempts, it logs the failure.

### Breaking the Loop

Assume we're monitoring a production machine in a factory. If the temperature of the machine goes above a certain limit, we want to stop the machine to prevent damage.

```ts
flow.register('machineMonitor', [
    {
        while: 'machineRunning',
        steps: [{ id: 'checkTemperature' }, { break: 'temperature > safeLimit' }, { id: 'continueOperation' }],
    },
    { id: 'stopMachine', condition: 'temperature > safeLimit' },
])
```

In this case, we check the machine's temperature while it's running. If the temperature goes above the safe limit, we break the loop and stop the machine.

### Continuing the Loop

Suppose we are validating a list of data entries. If we encounter an invalid entry, we want to skip it and continue with the next one.

```ts
flow.register('dataValidation', [
    {
        while: 'entries.length > 0',
        steps: [{ id: 'checkValidity' }, { continue: '!isValid' }, { id: 'processData' }],
    },
    { id: 'logInvalidEntries', condition: 'invalidEntries.length > 0' },
])
```

In this example, we validate each data entry. If an entry is not valid, we skip processing it and continue to the next entry. After validating all entries, we log the invalid ones.

These examples better illustrate how the 'while', 'break', and 'continue' constructs can be utilized in real-world scenarios to create dynamic and flexible workflows.

# API Reference

## Class: Step

A minimum action within a workflow. Each Step instance represents a single step of a workflow.

### `new Step(id, handler, globals?)`

Constructs a new step object.

**Parameters**

- `id`: Unique string identifier for the step.
- `handler`: Function or a string of JavaScript code that will be executed as a function during the step.
- `globals` (optional): An object with global variables that are available in the string handler.

### `step.handle(ctx, input)`

Executes the step handler with the provided context and input.

**Parameters**

- `ctx`: The context object, usually storing state data.
- `input`: The input data to the handler.

**Returns**

The return value from the step handler.

## Function: createStep

A shortcut for creating a workflow step.

**Parameters**

- `id`: Unique string identifier for the step.
- `opts`: An object containing:
  - `input` (optional): Instructions for step inputs.
  - `handler`: A function or a string of JavaScript code that will be executed as a function during the step.

**Returns**

A new Step object.

## Class: Workflow

A container for managing and executing workflows.

### `new Workflow(steps)`

Constructs a new workflow object.

**Parameters**

- `steps`: An array of `Step` objects to be included in the workflow.

### `workflow.register(id, schema)`

Registers a flow (sequence of steps) under an ID.

**Parameters**

- `id`: Unique string identifier for the schema.
- `schema`: A schema describing the sequence and structure of steps for the workflow.

### `workflow.start(schemaId, inputContext, input?)`

Starts a workflow by its schema ID.

**Parameters**

- `schemaId`: The ID of the schema to start.
- `inputContext`: The initial context to pass into the workflow.
- `input` (optional): The initial input for the first step, if required.

**Returns**

A promise that resolves to the final output of the workflow.

### `workflow.resume(schemaId, state, input)`

Resumes (or retries) an interrupted workflow from a saved state.

**Parameters**

- `schemaId`: The ID of the schema to resume.
- `state`: An object containing the indexes and context from the flow result state.
- `input`: Input for the interrupted step.

**Returns**

A promise that resolves to the final output of the resumed workflow.

## Class: StepRetriableError

An error class representing a retriable error.

### `new StepRetriableError(originalError, inputRequired?)`

Constructs a new StepRetriableError object.

**Parameters**

- `originalError`: The original error that triggered this retriable error.
- `inputRequired` (optional): The input that is required to retry the step.

**Note:** All methods and functions that involve executing JavaScript code from strings make use of a restricted execution environment where certain global objects and functions are not accessible in order to prevent potential malicious code execution. Always ensure that the JavaScript code you pass into these handlers is safe and trusted.
