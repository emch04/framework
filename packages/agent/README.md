# @astratra/agent

Durable task execution built on `runToolLoop` from `@astratra/ai`. Models,
application tools, completion checks and persistence are injected. Node >= 20,
CommonJS, MIT. No provider or database driver is included.

```sh
npm install @astratra/agent
```

```js
const { createAgent, createMemoryTaskStore } = require('@astratra/agent');

const agent = createAgent({
  store: createMemoryTaskStore(),
  turn: async ({ system, messages, tools, signal, phase }) => {
    // Adapt the application's provider to this response shape.
    return { text: 'The result is 3.', toolCalls: [],
      usage: { inputTokens: 40, outputTokens: 8 } };
  },
  budget: { maxMs: 600000, maxTurns: 200, maxTokens: 100000, maxCost: 2 },
  pricing: { inputPerMillion: 1, outputPerMillion: 4 },
  verify: ({ text }) => ({ complete: text.includes('3'), feedback: 'Compute the result.' }),
  onEvent: async (event) => { /* Forward or persist application events. */ }
});

const task = await agent.run({ question: 'Compute 1 + 2.' });
console.log(task.state, task.text, task.usage);
```

## Execution API

- `createAgent(options)` returns `{ store, create, run, resume }`.
- `create({ id?, question, messages? })` stores a pending task without running it.
- `run(input, { signal?, confirmation? }?)` creates and executes a task.
- `resume(id, { signal?, confirmation? }?)` acquires the lease and continues the
  saved transcript, pending tool calls, plan, usage and verification count.
  Completed and cancelled tasks are returned unchanged. Failed tasks can resume
  with a new runner, for example with a larger budget.

`turn({ system, messages, tools, signal, phase })` returns
`{ text?, toolCalls?, usage? }`. Each tool call has `{ id, name, args }`; IDs
must be non-empty and unique within a turn. Phases are `execution`, `summary`,
`verification` and `final`. Tools use the native `@astratra/ai` contract:
`{ name, description, parameters, kind, run, perform?, undo? }`. The injected
context adds `taskId`, `idempotencyKey` and `signal` for each tool execution.
The runner executes tool groups serially to checkpoint each result separately.
Tool errors remain visible to the model through `createToolCaller`.

## Budgets and consumption

Defaults: one hour and 1000 model requests. `maxTokens` and `maxCost` are optional.
`maxMs` measures active execution time across resumptions; time spent waiting for
confirmation or between processes is excluded. Model summary and verification
requests count toward the same budget. The next request is prevented once a
limit is reached. A request already started can exceed a token or money limit:
this is accounting, not a provider-side spending cap.

When a budget is exhausted, a final model request with no tools has a separate
`finalMs` timeout (default 30000 ms). This one request is recorded and may exceed
the configured token, cost and turn limits. `finalInstruction` customizes its
instruction. External cancellation interrupts models, checks and summaries even
when they do not settle their promises, and propagates to tools. Providers and
tools must honor their signal to stop underlying work.

Usage accepts `inputTokens` / `outputTokens` or `prompt_tokens` /
`completion_tokens`, plus optional `cost`. Missing counts are estimated from
serialized characters divided by four, rounded up. `pricing` specifies input
and output prices per million tokens in the application's currency; absent
prices mean cost zero. The `estimated` flag is recorded for each turn. Requests
that fail before returning usage are counted as turns but their provider cost
is unknown. `usageHistory` and `usage` expose per-turn and aggregate accounting.

## Plans, checks and summaries

The built-in `update_plan` tool replaces the plan with
`{ steps: [{ id, text, state }] }`. States: `todo`, `in_progress`, `done`,
`abandoned`. Duplicate IDs and malformed steps are rejected. The name is
reserved. The current plan is included in the execution system instruction
and is stored separately from the transcript.

`verify({ task, text, signal })` returns a boolean or `{ complete, feedback? }`.
Alternatively, `verificationInstruction` runs a model request without tools,
expecting JSON `{ "complete": boolean, "feedback": string }`. An incomplete
answer adds feedback and resumes execution, at most `maxVerificationRetries`
times (default 3). Checks are optional; without one, normal model completion is
accepted. `verified` and `stopReason` distinguish accepted completion from
budget exhaustion or verification failure. An incomplete final task is `failed`.
Malformed checks fail explicitly.

`contextSummary: { maxChars?, maxTokens?, keepLast? }` enables compaction.
The default retained tail is eight messages. Complete tool exchanges are retained
when the boundary falls inside one, so more than N messages may remain.
`summarize({ messages, plan, signal })` returns non-empty summary text. Without
it, a model request without tools uses `summaryInstruction` or a default
instruction. The tail and separate plan remain intact; previous messages are
replaced by a system summary. Compaction failure preserves the original history.

## Persistence, confirmation and leases

States: `pending`, `running`, `waiting_confirmation`, `completed`, `failed`,
`cancelled`. `TaskStore` requires:

```ts
create(task: Task): Promise<Task>
get(id: string): Promise<Task | null>
acquire(id: string, owner: string, leaseMs: number): Promise<boolean>
renew(id: string, owner: string, leaseMs: number): Promise<boolean>
save(task: Task, owner: string): Promise<Task>
release(id: string, owner: string): Promise<void>
```

Create refuses duplicates. Acquire is atomic and exclusive; renew and save
require the current, unexpired owner. Release must never clear another owner's
lease. The runner renews its lease every third of `leaseMs` (default 30000 ms).
A restarted process can resume after the previous lease expires. The memory
store copies values but is lost when the process exits.

Model responses, consumption, plans and each tool result are checkpointed.
Completed tool results are reused on resume. A crash between an external effect
and its checkpoint can replay the tool: use the stable `idempotencyKey` in the
external system. Exactly-once external effects cannot be guaranteed by a task
store. A process that loses its lease is aborted and cannot save stale results;
non-cooperative external operations may still finish, so enforce idempotency
and cancellation at their boundary. Application authorization and tenant access
to task IDs remain the application's responsibility.

A `confirm` tool pauses before `perform`; the task exposes
`confirmation: { key, call }`. Resume with
`{ confirmation: { key, approved: true } }` to perform it, or `approved: false`
to record rejection. No application write is performed before approval. The
runner itself does not authenticate the person approving the action.

```js
const { createPostgresTaskStore, postgresTaskSchema } = require('@astratra/agent');
// db is an application-owned pg Pool or compatible query adapter.
await db.query(postgresTaskSchema({ table: 'background_tasks' }));
const store = createPostgresTaskStore(db, { table: 'background_tasks' });
```

Schema creation is explicit and idempotent, with a JSONB task record and lease
columns. All data uses SQL parameters. Table names must be plain identifiers.
No other package's migration is changed. PostgreSQL is not a runtime dependency.

## Events and helper exports

`onEvent(event)` is awaited. Events: `plan`, `step`, `usage`, `summary`,
`verification`, `confirmation`, `final`; each carries `taskId`. Event delivery
is not transactional with the checkpoint; use application outbox infrastructure
if delivery must survive a crash. Handler errors fail execution explicitly.

Also exported: `PLAN_STATES`, `TASK_STATES`, `validatePlan`, `createPlanTool`,
`validateTask`, `estimateTokens`, `normalizeBudget`, `usageOf`, `budgetReason`,
`contextBoundary`, `summarizeContext`. Full signatures are in `src/index.d.ts`.

## Tests

`npm test -w @astratra/agent` uses `node --test`. Real PostgreSQL tests run only
with `AGENT_TEST_DATABASE_URL` naming a database ending in `_test`; otherwise
that test is skipped. The test creates and drops its own randomly named table.
