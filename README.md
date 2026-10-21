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
        handler:
            'ctx.result < 0 ? new StepRetriableError(new Error("test error")) : undefined',
    }),
];

// Create a workflow
const flow = new Workflow<{ result: number }>(steps);

// Register a sequence of steps
flow.register('add-mul-div', ['add', 'mul', 'div']);

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
    createStep('checkInventory', {
        /* configuration */
    }),
    createStep('processPayment', {
        /* configuration */
    }),
    createStep('packItem', {
        /* configuration */
    }),
    createStep('shipItem', {
        /* configuration */
    }),
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
    createStep('validateEmail', {
        /* configuration */
    }),
    createStep('sendConfirmationEmail', {
        /* configuration */
    }),
    createStep('verifyConfirmation', {
        /* configuration */
    }),
    createStep('createAccount', {
        /* configuration */
    }),
    createStep('sendWelcomeEmail', {
        /* configuration */
    }),
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
    createStep<{ username: string; password: string }>('login', {
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
        steps: ['generate-mfa', 'send-mfa', 'input-mfa'],
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
    },
    {
        name: 'password',
        label: 'Password',
        type: 'password',
        required: true,
    },
];

const mfaInputs: TAuthInputMetadata[] = [
    {
        name: 'mfaCode',
        label: 'Code',
        type: 'pin',
        required: true,
    },
];
```

These metadata are associated with the corresponding steps as their `input` property when the steps are created. When a step is run without the required inputs, it will be interrupted, and the `inputRequired` property of the result will contain the required inputs.

### Running the Workflow

When a user attempts to login, we start the `login` workflow:

```ts
// initiate the flow
const result = await AuthFlow.start('login', {});
if (!result.finished) {
    // respond with result.inputRequired that contains array `loginInputs`
    // save result.state somewhere (can be db, can be encrypted in token)
}
```

If the workflow is not finished, i.e., it needs user input, we save the workflow state and send the required input fields (`result.inputRequired`) to the frontend for the user to fill in.

Once we receive the required inputs from the user, we can resume the workflow:

```ts
// resuming flow when get inputs from user
await AuthFlow.resume('login', result.state, input); // where input is { username, password } from user
```

## While Loops in Workflows

Suppose we're building an email campaign that retries sending emails to users until a successful delivery or a predefined limit is reached.

```ts
flow.register('emailRetry', [
    {
        while: 'attempts < 5 && !emailSent',
        steps: [
            { id: 'sendEmail', input: 'user@email.com' },
            { id: 'increaseAttempts' },
        ],
    },
    { id: 'logFailure', condition: '!emailSent' },
]);
```

In this example, the workflow will keep trying to send an email to a user up to 5 times. After 5 attempts or a successful email delivery, it will break out of the loop. If the email isn't sent successfully after all attempts, it logs the failure.

### Breaking the Loop

Assume we're monitoring a production machine in a factory. If the temperature of the machine goes above a certain limit, we want to stop the machine to prevent damage.

```ts
flow.register('machineMonitor', [
    {
        while: 'machineRunning',
        steps: [
            { id: 'checkTemperature' },
            { break: 'temperature > safeLimit' },
            { id: 'continueOperation' },
        ],
    },
    { id: 'stopMachine', condition: 'temperature > safeLimit' },
]);
```

In this case, we check the machine's temperature while it's running. If the temperature goes above the safe limit, we break the loop and stop the machine.

### Continuing the Loop

Suppose we are validating a list of data entries. If we encounter an invalid entry, we want to skip it and continue with the next one.

```ts
flow.register('dataValidation', [
    {
        while: 'entries.length > 0',
        steps: [
            { id: 'checkValidity' },
            { continue: '!isValid' },
            { id: 'processData' },
        ],
    },
    { id: 'logInvalidEntries', condition: 'invalidEntries.length > 0' },
]);
```

In this example, we validate each data entry. If an entry is not valid, we skip processing it and continue to the next entry. After validating all entries, we log the invalid ones.

These examples better illustrate how the 'while', 'break', and 'continue' constructs can be utilized in real-world scenarios to create dynamic and flexible workflows.

## Outlets (`@prostojs/wf/outlets`)

Workflow outlets deliver pauses to the outside world (HTTP forms, emails, pending tasks) and manage state persistence between round-trips. Import from the sub-export:

```ts
import { outlet, outletHttp, outletEmail } from '@prostojs/wf/outlets';
import { EncapsulatedStateStrategy, HandleStateStrategy, WfStateStoreMemory } from '@prostojs/wf/outlets';
import { mintWfStateToken, hashWfHandle, resolveExpiresAt } from '@prostojs/wf/outlets';
```

### Step Helpers

Use these in step handlers to pause the workflow via an outlet:

```ts
// Generic outlet
return outlet('pending-task', { payload: approvalForm, target: managerId });

// HTTP form pause — delivers payload and state token in the response
return outletHttp(LoginForm, { error: 'Invalid credentials' });

// Email with magic link containing the state token
return outletEmail('user@test.com', 'invite', { name: 'Alice' });
```

### State Strategies

Two built-in strategies for persisting workflow state between round-trips.
**Choose based on whether your flow is security-sensitive.** See the security
note at the end of this section.

**EncapsulatedStateStrategy** — self-contained AES-256-GCM encrypted tokens. No
server storage needed. Appropriate for **idempotent, non-sensitive** flows
(multi-step forms, data collection). See security warning below.

```ts
import { randomBytes } from 'node:crypto';

const strategy = new EncapsulatedStateStrategy({
    secret: randomBytes(32),
    defaultTtl: 3600_000, // 1 hour
});

const token = await strategy.persist(result.state);  // encrypted base64url string
const state = await strategy.retrieve(token);         // null if expired/tampered
```

**HandleStateStrategy** — server-side storage with short opaque handles. Supports
true single-use tokens via atomic `consume()`. **Required for security-sensitive
flows** (auth, password reset, invite accept, financial operations).

```ts
const strategy = new HandleStateStrategy({
    store: new WfStateStoreMemory(), // in-memory for dev; implement WfStateStore for production
    defaultTtl: 3600_000,
});

const handle = await strategy.persist(result.state);
const state = await strategy.consume(handle);  // atomic retrieve + delete (single-use)
```

`persist()` takes `{ ttl }` (ms from now, overrides `defaultTtl`; a
non-positive or non-finite value means "never expires") and/or `{ expiresAt }`
(absolute ms timestamp, `0` = never; `defaultTtl` is then not applied). With
both, the **earlier** expiry wins, so combining them can only shorten a
lifetime. An invalid `expiresAt` (negative, `NaN`, infinite) throws a
`TypeError` before anything is written. The exported
`resolveExpiresAt(options, defaultTtl, now?)` applies these rules for custom
strategies.

#### Expiry-aware persist and consume (`persistEntry` / `consumeEntry`)

Both built-in strategies have entry variants that also report the absolute
expiry (`0` = never expires, `undefined` = unknown):

- `persistEntry(state, options?, overrides?)` → `{ token, expiresAt }`: the
  expiry `persist()` applied.
- `consumeEntry(token)` → `{ state, expiresAt }` or `null`: `consume()` with
  exactly the same atomicity, plus the token's expiry.

Together they put a consumed state back without extending its lifetime, for
example when a step fails and the user should be able to retry with the same
link:

```ts
const entry = await strategy.consumeEntry(token);
if (!entry) return gone();
try {
    await runStep(entry.state);
} catch (error) {
    // Restore ONLY when the expiry is known.
    if (entry.expiresAt !== undefined) {
        await strategy.persistEntry(
            entry.state,
            { expiresAt: entry.expiresAt },
            { handle: token },
        );
    }
    throw error;
}
```

- Never substitute a value for an unknown expiry (`?? 0` would make the token
  permanent). The expiry is unknown for entries written by 0.2.x (unless the
  store returns a bound), for stores that drop `state.meta`, and when a
  subclass overrides `consume()`.
- `HandleStateStrategy` records the expiry it applied inside the persisted
  state (under the reserved `state.meta.__wfExpiry`, removed again on every
  read), so it knows the expiry even when your store leaves expiry to its
  backend (Redis `PX`, a MongoDB TTL index) and returns only `{ state }`.
- `persistEntry` is the signal that a strategy **honours `expiresAt`**. Both
  entry methods are optional on `WfStateStrategy`; a strategy without
  `persistEntry` (e.g. one written against 0.2.x) may read only `ttl`, so pass
  it a `ttl` instead (`mintWfStateToken` does this automatically).
- Subclasses: if you override `consume()` or `persist()`, the entry variant
  delegates to your override and reports the expiry as unknown (`persistEntry`
  then passes `expiresAt` folded into a `ttl`). Call `super.consume()` /
  `super.persist()` from the override, never the entry variants.
- `EncapsulatedStateStrategy.consumeEntry()` returns the expiry its token
  carries and, like `consume()`, does not invalidate the token.

#### Hashing handles at rest (`hashHandles`)

By default `HandleStateStrategy` uses the handle itself as the store key, so
anyone who can read the store (a backup, a replica, a log, an injection) holds
live resumption tokens. Turn on `hashHandles` to store a hash instead:

```ts
const strategy = new HandleStateStrategy({
    store,
    defaultTtl: 3600_000,
    hashHandles: true, // or { secret: process.env.WF_HANDLE_PEPPER }
});
```

- The client still receives the raw handle; the store only ever sees
  `hashWfHandle(handle, secret?)`: `wfh1_` + base64url(SHA-256), or `wfk1_` +
  base64url(HMAC-SHA-256) with a secret — a 48-character string.
- New handles: with hashing on, the default generator issues 22 base64url
  characters (128 random bits) that never contain `wfh`/`wfk`, instead of a
  UUID. This shape never takes the raw-key fallback below, so it costs no
  extra lookups. With hashing off, handles stay UUIDs. Do not rely on the
  shape of a handle; treat it as an opaque string.
- `true` uses plain SHA-256. That is safe for the default handles (128 random
  bits): nobody can recover a handle from its hash. Pass `{ secret }` (HMAC) when a custom `generateHandle` produces
  guessable handles. Changing the secret invalidates every in-flight handle.
  A `secret` property that is present but `undefined` or empty (an unset
  environment variable) throws instead of silently falling back to SHA-256.
- The store must compare keys exactly (see
  [Implementing a `WfStateStore`](#implementing-a-wfstatestore), rule 5), and
  a key column typed as UUID must become text or binary.
- A hashed key read from the store is never accepted as a token.
- Default: off. Turn it on for every instance at once; a flow paused on an
  instance with hashing cannot be resumed on one without it.

**Upgrade (raw-key fallback).** When the hashed key misses, the strategy also
looks the token up under its raw key, so handles issued before you turned
`hashHandles` on keep working; re-persisting such a handle moves it to the
hashed key. The fallback only applies to tokens positively shaped like a
pre-upgrade handle:

- with the default `generateHandle`: a strict lowercase UUID v4 (what 0.2.x
  issued);
- with a custom `generateHandle`: whatever `hashHandles.legacyHandle(token)`
  accepts. Without `legacyHandle` the fallback is off (fails closed), and
  `rawFallback: true` without it throws. An explicit `generateHandle` counts
  as custom even if it is `randomUUID`.
- Never for tokens that are not printable ASCII (`/^[\x21-\x7e]+$/`: no
  whitespace, accents or compatibility characters) or that contain `wfh` /
  `wfk` in any case. `legacyHandle` is only ever called with tokens that pass
  this check.

```ts
hashHandles: {
    legacyHandle: (t) => /^[0-9a-f]{32}$/.test(t), // the shape your generator issued
}
```

`hashHandles: { rawFallback: false }` turns the fallback off. It exists in
**0.3.x only: 0.4.0 removes it** (and `legacyHandle`), after which pre-upgrade
handles no longer resolve. Turn `hashHandles` on at least one full TTL before
upgrading to 0.4.0.

#### Minting a token without a request (`mintWfStateToken`)

For server-initiated flows (invites, approval requests, admin-issued links),
start the workflow headlessly and get its resumption token back:

```ts
import { mintWfStateToken } from '@prostojs/wf/outlets';

const { token, expiresAt } = await mintWfStateToken(workflow, {
    strategy, // HandleStateStrategy, ideally with hashHandles
    schemaId: 'invite',
    context: { email: 'new.user@example.com' },
    ttl: 7 * 24 * 3600_000,
});
if (token) await sendInviteEmail(`https://app.example.com/invite?wfs=${token}`);
```

- The first argument is anything with `start(schemaId, context, input?)`, such
  as a `Workflow`.
- `token` is set only when the flow paused (asked for input); a flow that
  finishes right away yields `token: undefined` and persists nothing. If the
  flow, the `meta` function or the strategy picker throws, nothing is
  persisted and the error propagates.
- Expiry: the **earlier** of `ttl` and the `expires` the pausing step
  returned; with neither, the strategy's `defaultTtl`. `ttl: 0` means "never"
  (and loses to a step's `expires`); a negative, `NaN` or infinite `ttl`
  throws a `TypeError` before the flow runs.
- A strategy with `persistEntry` gets `{ ttl, expiresAt }` and the result's
  `expiresAt` is the absolute expiry it applied (`0` = never). A strategy
  without it receives the earlier bound as a `ttl` (at least 1 ms, so a bound
  already past means "expired now"), and the result's `expiresAt` is
  `undefined`.
- `meta` (object, or a function of `{ inputRequired, output }`) is merged into
  `state.meta`; `strategy` may be a function that picks the strategy from the
  pause request.
- No outlet is called: you deliver the token. The token is always freshly
  minted, never a caller-chosen handle.
- The token is the strategy's raw token. A token that must resume through a
  `@wooksjs/event-wf` outlet trigger also needs the strategy-name prefix that
  trigger expects; wooks will provide a wrapper for that.

#### Implementing a `WfStateStore`

A production store must follow the contract documented on `WfStateStore`.
Breaking it breaks single-use tokens or hashing at rest:

1. **`getAndDelete` is atomic**: among concurrent calls for the same key
   exactly one gets the entry. A `get` followed by a `delete` is not atomic,
   even in one process (any `await` in between lets a second caller in). Use
   one atomic operation: `DELETE ... RETURNING` (PostgreSQL, SQLite), `GETDEL`
   (Redis), `findOneAndDelete` (MongoDB), or a row-locking transaction.
2. **`get` is side-effect free**: it never deletes, extends or changes a live
   entry (dropping an already-expired one is fine).
3. **Expired entries are never returned** (`Date.now() > expiresAt`).
   `HandleStateStrategy` re-checks the expiry, but a store that hands out
   expired entries from `getAndDelete` still loses single use for them. A
   backend-TTL store must also accept an `expiresAt` already in the past.
4. **`set` overwrites** the entry and its expiry.
5. **Keys compare exactly**: binary, case-sensitive, no padding, no Unicode
   normalisation.
   - MySQL/MariaDB: `VARBINARY(64)`, or `VARCHAR(64) COLLATE utf8mb4_0900_bin`
     (NO PAD). Not the default `*_ci` collations, and not `utf8mb4_bin`, which
     is PAD SPACE.
   - SQL Server: a `VARBINARY(64)` key column. `(n)varchar` ignores trailing
     spaces in `=` under every collation, and the default collations are
     case-insensitive; at minimum use a `_BIN2` collation.
   - PostgreSQL: `text`/`varchar` with a deterministic collation (the
     default, or `COLLATE "C"`); not `citext` or a nondeterministic ICU
     collation.
6. **`expiresAt` is echoed exactly or not at all**: if `get`/`getAndDelete`
   return `expiresAt`, it is the value given to `set`.
7. **The state round-trips, including `state.meta`** (JSON is fine).
   `HandleStateStrategy` keeps the expiry it applied there; a store that drops
   `meta` makes consumed tokens unrestorable.

Check your store with the bundled, framework-agnostic contract check:

```ts
import { checkWfStateStoreContract } from '@prostojs/wf/testing';

it('MyStore meets the WfStateStore contract', async () => {
    expect(await checkWfStateStoreContract(() => new MyStore(db))).toEqual([]);
});
```

It returns the list of violations. Every check uses fresh random 48-character
keys and deletes them in a `finally`, so it can run against a shared test
database. Object key order is ignored when comparing states (jsonb columns
that reorder keys pass). Limits: the atomicity check fires concurrent calls
from one process only, so it cannot prove atomicity across processes — that
comes from the backend operation you use. The expiry probe stores a
short-lived entry, reads it several times during its lifetime (to catch a
`get()` that slides the expiry), and checks that it is gone afterwards. It
waits about `expiryProbeMs` of real time (default 1000 ms), so run it with
real timers. The probe measures the store's round trip and stretches itself
to at least 10× that, so network latency does not read as a violation. For
backends with coarse expiry resolution (second-granularity TTLs, a background
sweeper) or clock skew between app and database, raise `expiryProbeMs`
accordingly, e.g. `checkWfStateStoreContract(make, { expiryProbeMs: 3000 })`.

`WfStateStoreMemory` meets this contract within one process (dev and tests
only; state is lost on restart and not shared between instances).

#### Upgrading to 0.3.0

- [ ] **Custom stores:** run `checkWfStateStoreContract` (see
  [Implementing a `WfStateStore`](#implementing-a-wfstatestore)), in
  particular atomic `getAndDelete`, the key column collation (rule 5) and
  keeping `state.meta`.
- [ ] **Custom strategies:** implement `persistEntry` only if `persist()`
  honours `expiresAt` (see
  [`persistEntry` / `consumeEntry`](#expiry-aware-persist-and-consume-persistentry--consumeentry)).
- [ ] **Subclasses overriding `consume()`/`persist()`:** call `super`, never the
  entry variants.
- [ ] **Before enabling `hashHandles`:** read
  [Hashing handles at rest](#hashing-handles-at-rest-hashhandles). New
  handles are no longer UUIDs while it is on; check that nothing parses them.
- [ ] **Set a `defaultTtl`** before moving to 0.4.0: a pre-upgrade raw handle
  that never expires is stranded once 0.4.0 removes the raw-key fallback.
- [ ] **Custom handles containing `wfh`/`wfk`:** the fallback never accepts
  them. About 0.1% of 22-character random base64url handles contain one (hex
  handles never do); such pre-upgrade handles stop resolving as soon as
  `hashHandles` is on. Re-issue them, or keep hashing off until they expire.
- [ ] **Rollback to 0.2.x:** entries written by 0.3.0 still resume if
  `hashHandles` was off, but 0.2.x does not strip `state.meta.__wfExpiry`, so
  their state carries it. With `hashHandles` on, 0.2.x cannot find hashed
  entries at all: a rollback strands every token issued since hashing was
  enabled.

#### Security note — token replay

A workflow resumption token lets the holder re-execute the workflow from the
paused step. Any token that stays valid after use is a replay vector for
whoever can copy it (browser history, logs, proxies, shared devices).

- `HandleStateStrategy.consume()` atomically deletes the handle — truly
  single-use, race-safe via the store's `getAndDelete` (provided the store
  follows the contract above).
- `retrieve()` never invalidates a token on either strategy, so it is safe to
  inspect a token before deciding whether to consume it.
- `EncapsulatedStateStrategy.consume()` is a stateless no-op. A copy of the
  token remains valid for the full TTL. This strategy CANNOT enforce
  single-use.

**Use `EncapsulatedStateStrategy` only when every step is idempotent and the
flow carries no security impact.** For anything else — credential changes,
financial actions, account provisioning, anything with real-world side
effects — use `HandleStateStrategy` backed by a durable `WfStateStore`.

### Custom Outlets

Implement the `WfOutlet` interface to create custom delivery mechanisms:

```ts
import type { WfOutlet, WfOutletRequest, WfOutletResult } from '@prostojs/wf/outlets';

const slackOutlet: WfOutlet = {
    name: 'slack',
    async deliver(request: WfOutletRequest, token: string): Promise<WfOutletResult> {
        await slack.postMessage(request.target!, {
            text: `Action required: ${request.payload}`,
            actions: [{ url: `https://app.com/resume?token=${token}` }],
        });
        return { status: 200, response: { message: 'Notification sent' } };
    },
};
```

# API Reference

## Class: Step

A minimum action within a workflow. Each Step instance represents a single step of a workflow.

### `new Step(id, handler, opts?)`

Constructs a new step object.

**Parameters**

- `id`: Unique string identifier for the step.
- `handler`: Function or a string of JavaScript code that will be executed as a function during the step.
- `opts` (optional): An object with:
    - `globals`: Global variables available in string handlers.
    - `input`: Input descriptor — if set, the step pauses with `{ inputRequired }` when called without input.

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
