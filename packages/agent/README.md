# @astratra/agent

[English](README.md) | [Français](README.fr.md)

Durable task execution built on `runToolLoop` from `@astratra/ai`. Models,
application tools, completion checks and persistence are injected. Node >= 20,
CommonJS, MIT. No provider or database driver is included.

```sh
npm install @astratra/agent
```

```js
const { createAgent, createMemoryTaskStore } = require('@astratra/agent');

const agent = createAgent({
  guards: false, // or recommendedGuards({ models }) from '@astratra/ai/guards': see "Guards" below
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

## Guards (on by default)

`createAgent({ guards })` takes the guards of `@astratra/ai/guards`
(`recommendedGuards` or `createGuards`, built on the injected
`@astratra/models` client) so every agent made with the package is protected:

```js
const { recommendedGuards } = require('@astratra/ai/guards');
const guards = recommendedGuards({ models });          // add readOnly: true for an agent that cannot act
const agent = createAgent({ guards, turn, tools, onEvent });
```

| Moment | Guard |
| --- | --- |
| start of a task | `newRun`: mode `action` when a tool has kind `write` or `confirm`, otherwise `read` (the failure policy follows the mode) |
| the question and earlier messages, before any model | `input`: names and personal data masked. A blocked input fails the task (`error.code === 'GUARD_BLOCKED'`) |
| each tool result | `toolResult`: masked; for a tool marked `external: true` (web, e-mail, files) also scanned for injection and framed as untrusted data. A result `{ untrusted: true, content }` is treated as external too |
| before a tool of kind `write` or `confirm` | `beforeAction` |
| the final reply | `output`: unmasked, then grounding in the sources read, personal-data leak, moderation |

**Refused action.** After an injection is suspected, a `write` tool does not
run: the task becomes `waiting_confirmation` with
`confirmation: { key, call, guard: { reason: 'confirmation_required' } }`.
Resume with `{ confirmation: { key, approved: true } }` (from your interface,
never from the model) to run that call, or `approved: false` to record a
rejection the model reads. A refusal for any other reason is returned to the
model as a tool error (`Blocked by a guard: ...`) and the tool does not run.
`confirm` tools already wait for a person; their confirmation carries
`guard: { requiresConfirmation: true }` when an injection was suspected, and
`beforeAction` is asked again, with the person's confirmation, before `perform`.

**Reply.** A blocked reply is never delivered: the task is `failed`,
`stopReason: 'guard'`, `task.text` is absent. A flagged reply (for example
claims the sources do not support) is delivered, and `task.guard` keeps
`{ decision, reasons, degraded, groundingScore, unsupportedClaims }` (numbers
and codes, no text). `verify` receives the unmasked, checked reply.

**Events.** Guard decisions reach `onEvent` as `{ type: 'guard', taskId, guard,
decision, reasons, degraded, metrics, runId, mode, at }` (the run id is the task
id). They never contain text.

**State and resumption.** The state of the guards is kept in the task
(`task.guards`) after the input and after each tool result: the masking table,
the confirmation flag, hashes of the personal data the person gave, and the
external sources read, masked. A resumed task, even in a new process with new
guards, unmasks with the same tokens and still requires the confirmation.
The messages in the task are stored masked and `task.maskedQuestion` is what
the model reads. Note that the masking table holds the real values (it is how a
reply is unmasked) and `task.question` is kept as given: protect the task store
as the data it holds. Tools receive `context.unmask(text)` to turn a token the
model wrote back into the real value; arguments are otherwise passed as the
model wrote them.

**Default.** `guards` is a choice, not an option to forget:

- `NODE_ENV=production` and no `guards`: `createAgent` throws
  `guards required in production: pass guards or guards:false`.
- elsewhere and no `guards`: nothing is guarded and one `warning` event
  (`code: 'guards_missing'`) is sent per agent.
- `guards: false`: explicit, silent opt-out.

Tests can use `createMockGuards` and `createFakeModels` from
`@astratra/ai/guards/testing`.

## Events and helper exports

`onEvent(event)` is awaited. Events: `plan`, `step`, `usage`, `summary`,
`verification`, `confirmation`, `final`, `guard`, `warning`; each carries `taskId`. Event delivery
is not transactional with the checkpoint; use application outbox infrastructure
if delivery must survive a crash. Handler errors fail execution explicitly.

Also exported: `PLAN_STATES`, `TASK_STATES`, `validatePlan`, `createPlanTool`,
`validateTask`, `estimateTokens`, `normalizeBudget`, `usageOf`, `budgetReason`,
`contextBoundary`, `summarizeContext`. Full signatures are in `src/index.d.ts`.

## User feedback (thumbs up / down)

`@astratra/agent/feedback` (also re-exported from the main entry) collects a
thumbs up or down on an agent run and lets the agent take it into account. It
has no AI-provider dependency; storage, identity, masking and run lookup are
injected.

```js
const express = require('express');
const { createAgent, createFeedback, createFeedbackRouter,
  createPostgresFeedbackStore, postgresFeedbackSchema } = require('@astratra/agent');

await db.query(postgresFeedbackSchema());              // explicit, idempotent
const feedback = createFeedback({
  store: createPostgresFeedbackStore(db),              // or createMemoryFeedbackStore()
  mask: (text) => masker.mask(text),                   // names -> tokens (see @astratra/ai masking)
  readRun: async ({ runId, tenantId }) => loadRun(runId)  // { question, mode, tools, answer }
});

const agent = createAgent({ turn, feedback });         // the digest joins the system prompt
const task = await agent.run({ question, userId, tenantId });
// task.id is the run id to give to the interface; events 'run' and 'final' carry runId.

app.use('/api', createFeedbackRouter({
  feedback,
  identify: (req) => ({ userId: req.user.id, tenantId: req.user.orgId }),
  resolveRun: async (req, runId, who) => ownedRun(runId, who) // falsy => 404
}));
```

**Model.** `{ id, tenantId?, userId, runId, messageId?, rating: 'up' | 'down',
reason?, comment?, agent?, mode?, createdAt, updatedAt }`, with times in epoch
milliseconds. One feedback per person and run (per tenant): giving again
replaces it, `update` modifies some fields, `remove` withdraws it. `reason`
belongs to `down` only and comes from a fixed list, `FEEDBACK_REASONS`
(`inaccurate`, `incomplete`, `off_topic`, `wrong_source`, `too_long`, `unsafe`,
`other`), extensible with `createFeedback({ reasons: ['slow'] })` (lowercase
names). `comment` is limited (`maxComment`, default 500) and refused above it,
never truncated silently. Invalid input throws `FeedbackError` (`invalid`,
`not_found`).

**Stores.** `createMemoryFeedbackStore()` and
`createPostgresFeedbackStore(db, { table })` with `postgresFeedbackSchema({ table })`.
Every value is a SQL parameter; table names must be plain identifiers (48
characters at most). A unique key on tenant, user and run makes concurrent
gives safe.

**Router.** `createFeedbackRouter({ feedback, identify, resolveRun, express?, maxBodyBytes? })`
(`express` is an optional peer dependency):

| Route | Effect |
| --- | --- |
| `POST /runs/:runId/feedback` | give or replace; 201 created, 200 replaced |
| `PATCH /runs/:runId/feedback` | change some of `rating`, `reason`, `comment`, `messageId` |
| `GET /runs/:runId/feedback` | read your own |
| `DELETE /runs/:runId/feedback` | withdraw; 204 |

The application supplies the identity (`identify`, 401 when falsy) and checks
that the run belongs to that person (`resolveRun`; falsy answers 404, exactly
like an unknown run). The identity never comes from the body; unknown body
fields are refused; the body is limited (default 8 KiB). `resolveRun` may
return `{ agent, mode }`, stored with the feedback for the statistics.

**The agent learns.** `createAgent({ feedback })` accepts a service from
`createFeedback` or a function `({ userId, tenantId, task, signal }) => string`.
At the start of a task with a `userId`, the text is added to the system
prompt, then kept in the task (`task.feedbackDigest`) so a resumed task sees the
same prompt. It is capped at 4000 characters, and a failing digest never fails
the task.

`feedback.feedbackDigest({ userId, tenantId?, since?, limit?, maxChars?, includeNotes?, maxNotes?, noteChars?, mask? })`
returns a short text (default: last 30 days, 20 feedbacks, 800 characters):
the number of disliked answers, the reasons aggregated with a hint each
(`reasonHints` overrides the sentences), and up to three quoted comments, each
masked with `mask`, scrubbed of e-mail addresses, links and numbers, stripped
of quotes and brackets, and cut to 120 characters. The text states that it is
preference data, not instructions. If the mask fails, notes are dropped, never
sent raw.

**From dislikes to tests.** `feedback.exportScenarioCandidates({ rating: 'down', since, tenantId?, limit? })`
reads each disliked run with the injected `readRun` and returns anonymous
candidates `{ id, name, input, question, mode, tools, expect: { tools, content: [] }, score: null, feedback, answer? }`.
A `mask` is mandatory (the call throws without one). No user or tenant id
appears; the id is a salted hash of the run; e-mails, links, numbers and the
person's own ids are scrubbed after masking. Review each candidate, fill
`expect.content`, then `toAgentScenarios(candidates, { fixtures })` gives
scenarios for `evaluateAgent` from `@astratra/testkit` (`fixtures` maps a tool
name to a deterministic `run`).

**Statistics.** `feedback.stats({ tenantId?, agent?, mode?, since?, until?, groupBy? })`
returns `{ total, up, down, upRate, downRate, groups }`, grouped by `agent`,
`mode`, `reason` (down only; missing reasons are `unspecified`) or `day` (UTC).
Rates are `null` when there is nothing. Omitting `tenantId` counts every
tenant: scope it for tenant dashboards.

The interface parts are `FeedbackBar` in `@astratra/native-ui` (React Native)
and `@astratra/saas-kit-ui` (web).

### Showing the answer while it is written

With guards, `turn` receives `unmask(text)`: the real words of a (masked) model text. With `onText` from
`@astratra/ai` (1.10.0) you can show a streamed answer without its masking markers (`#PERSON_0001`). The final answer
still goes through the output guard (leaks, moderation); what is sent to the model stays masked.

## Scheduler (timed tasks)

Tasks that run at a fixed time of day, on a weekday, or at an interval, in an IANA time zone. Nothing starts when the
module is loaded: you call `start()`.

```js
const { createScheduler } = require('@astratra/agent');

const scheduler = createScheduler({
  timeZone: 'Europe/Paris',
  maxLateMs: 6 * 3600 * 1000,                  // a run missed by more than 6 h is skipped, not run
  shouldStop: () => settings.killSwitch,        // checked before AND during each run
  tasks: [
    { id: 'daily-report', schedule: { type: 'daily', at: '07:00' }, run: ({ signal }) => buildReport(signal) },
    { id: 'weekly-digest', schedule: { type: 'weekly', day: 'monday', at: '07:30' }, run: sendDigest },
    { id: 'cleanup', schedule: { type: 'interval', everyMs: 15 * 60 * 1000 }, run: cleanUp }
  ]
});
scheduler.start();                              // periodic pass (every tickMs, 30 s by default)
await scheduler.run('cleanup');                 // manual run; does not move the next planned run
await scheduler.state();                        // lastRunAt, nextRunAt, status, lastResult, lastError, skipReason
scheduler.abortAll();                           // cuts every run in progress (their signal aborts)
scheduler.stop();                               // stops the periodic pass
```

- **Schedules**: `{ type: 'daily', at: 'HH:MM' }`, `{ type: 'weekly', day | days, at }` (1 = Monday … 7 = Sunday, or
  `'monday'`), `{ type: 'interval', everyMs }`. `timeZone` is global or per task. Daylight saving is handled: 07:00
  stays 07:00 on the wall clock. A time that does not exist (02:30 when clocks go forward) runs right after the gap; a
  time that happens twice runs once, at the first occurrence. `nextRun(schedule, afterMs, timeZone)` is exported.
- **Aligned interval (1.3.0)**: `{ type: 'interval', everyMs: 3600000, align: true }` runs on the round marks of the
  local day (07:00, 08:00…; every 15 min: :00, :15, :30, :45), counted from local midnight, whatever the start time.
  `everyMs` must be whole seconds and at most one day.
- **Live settings (1.3.0)**: a task's `enabled` (boolean or `async () => boolean`) and `schedule` (object or
  `async () => schedule`) are read at each pass, so a dashboard can switch a task off or move it without a restart. A
  disabled task has `nextRunAt: null`; a changed schedule is replanned at the next pass (outcome `'rescheduled'`, the
  task does not run in that pass). A function that throws or gives a wrong value is reported to `onError`; the task is left out of
  that pass (its plan is kept) and the other tasks go on. `state()` shows the
  current `enabled` and `schedule`.
- **Never twice at once**: each run takes a `lock` (`acquire(key)` → `{ release() }` or `null`). The default is an
  in-process lock; with several processes pass `createPostgresLock(pool)` (`pg_try_advisory_lock`, held on one pooled
  connection until released, freed if the process dies). The run state is re-read under the lock, so a process that
  lost the race does not run a task another one just finished. Share the `store` (below) between processes.
- **Missed runs**: a due run late by more than `maxLateMs` (per task or global, 1 h by default) is skipped with
  `skipReason: 'late'`, and the next one is planned. Within the delay it still runs.
- **Global stop**: `shouldStop()` is read before each run (a scheduled run is skipped with `'stopped'`, a manual run
  throws `SchedulerError('stopped')`) and every `stopCheckMs` (1 s) during a run; when it returns true the task's
  `signal` aborts. A failing `shouldStop` counts as stopped. A run cut this way is not counted as done.
- **State**: `status` is `scheduled`, `running` (informative: the lock is the truth), `ok`, `error` or `skipped`.
  `lastResult` (JSON) is passed to the next run as `previous`, for tasks that avoid repeating themselves.
- **State store**: memory by default; `createPostgresScheduleStore(db)` keeps it in a table
  (`postgresScheduleSchema()` creates it).
- **Tests**: inject `now` (a function returning ms or a `Date`) and call `tick()` yourself.
- `onEvent` (`start`, `done`, `error`, `skipped`) and `onError` observe the scheduler; they never break it.

## Approval queue (actions waiting for a decision)

Actions that a person must approve, **detached from any running task**: an action is proposed now and decided hours or
days later. The package does not authenticate anyone: you check identity and role (in your route, or in `authorize`) and
pass the decider. The action is executed by **your** executor.

```js
const { createApprovalQueue, ApprovalRefused } = require('@astratra/agent');

const queue = createApprovalQueue({
  executors: {
    publish: async ({ input, idempotencyKey, signal }) => {
      if (!input.title) throw new ApprovalRefused('incomplete', { missing: ['title'] });  // nothing done
      return await publishPost(input, { idempotencyKey, signal });                       // the result is stored
    }
  },
  authorize: ({ decider }) => decider.role === 'owner',         // your rule; false or a throw = forbidden
  beforeExecute: () => { if (settings.killSwitch) throw new Error('stopped'); },       // optional last check
  onEvent: ({ type, action }) => audit(type, action.id)         // proposed, approved, rejected, refused, failed, expired
});

const action = await queue.propose({ type: 'publish', input: { title: 'Hello' }, requestedBy: 'assistant', ttlMs: 3 * 24 * 3600 * 1000 });
await queue.list({ status: 'pending' });
await queue.approve(action.id, { decider: { id: 'user-1', role: 'owner' } });   // → { action, result }
await queue.approve(action.id, { decider, input: { title: 'Hello, world' } });   // the action as the person corrected it
await queue.reject(action.id, { decider: { id: 'user-1', role: 'owner' }, reason: 'not now' });
await queue.expire();                                                            // also done by list/approve/reject
```

- **Once only**: `approve` first *reserves* the action (`pending` → `approved`) in one atomic step of the store, then
  runs the executor. Two approvals at the same time: one runs, the other gets `ApprovalError('already_decided')`.
  With PostgreSQL the reservation is one conditional `UPDATE`. The executor receives `idempotencyKey` (the action id):
  use it with the external system, because a crash after the effect cannot be undone by a queue. An action stuck in
  `approved` with `executedAt: null` after a crash is findable with `list({ status: 'approved' })`.
- **Refusal**: if the executor throws `ApprovalRefused(reason, details)`, nothing happened: the action goes back to
  `pending` with `refusal: { reason, details, at, by }`, and the error is rethrown. Any other error does the same with
  `reason: 'execution_failed'` and is rethrown as `ApprovalError('execution_failed')` (the original is in `cause`).
- **Expiry**: `ttlMs` or `expiresAt` at `propose`. An expired action cannot be approved or rejected
  (`ApprovalError('expired')`), even if the sweep has not run yet. `expire()` marks them `expired`; call it from a
  timer or from a scheduler task.
- **Corrected input (1.3.0)**: `approve(id, { decider, input })` approves the action *as the person read and edited
  it*. `input` must be an object; `validateInput({ action, input, decider })` (option) may refuse it (`false` or a
  throw: `ApprovalError('invalid')`) or normalise it (`{ value }`). It is recorded as `decisionInput` in the same atomic
  reservation, before anything runs, and the executor receives it as `input` (the proposal stays as
  `proposedInput`). `authorize` sees it too. A refusal or failure clears it with the reservation.
- **Errors** (`ApprovalError.code`): `not_found`, `expired`, `already_decided`, `forbidden`, `no_executor`,
  `execution_failed`, `invalid`.
- **PostgreSQL store**: `createPostgresApprovalStore(db)` with `postgresApprovalSchema()` (it also adds the
  `decision_input` column to an older table). On **your own table** (1.3.0), map it:
  ```js
  createPostgresApprovalStore(db, {
    table: 'journal_actions',
    columns: { id: 'ref', type: 'outil', input: 'entree', requestedBy: 'demandeur', status: 'statut',
      createdAt: 'cree_le', expiresAt: 'expire_le', decidedBy: 'decide_par', decidedAt: 'decide_le',
      executedAt: 'execute_le', result: 'resultat', reason: 'motif', decisionInput: 'entree_validee',
      meta: null, refusal: null },                              // null: not kept
    statuses: { pending: 'en_attente', approved: 'approuvee', rejected: 'rejetee', expired: 'expiree' },
    scope: { column: 'necessite_accord', value: true }         // only these rows belong to the queue
  });
  ```
  Timestamps are `timestamptz`; `input`, `meta`, `result`, `refusal`, `decision_input` are `jsonb`. Names are checked
  (plain identifiers: letters, digits, `_`, at most 48 characters); all values are bound parameters. Rows outside `scope` are never read or
  changed. Without a `decisionInput` column, `approve` with `input` is refused (nothing runs).
- **Your own store (contract)**: memory by default; any object with these methods works. Each transition is one atomic
  step that returns the updated action, or `null` when its condition no longer holds (never throws for that):
  - `create(action)` stores a new action (all fields, `status: 'pending'`); `get(id)` → action or `null`;
  - `list({ status?, type?, requestedBy?, limit = 50, before? })` → most recent first (`createdAt` desc, then `id`);
  - `reserve(id, decidedBy, at, decisionInput)`: `pending` and not expired at `at` → `approved`, sets `decidedBy`,
    `decidedAt`, `executedAt: null`, and **stores `decisionInput`** (returns it, `null` when absent; a store that
    returns `undefined` is refused when an input is given);
  - `finish(id, result, at)`: `approved` and `executedAt` null → sets `result`, `executedAt`;
  - `revert(id, decidedBy, refusal)`: `approved` by this decider and not executed → `pending`, clears `decidedBy`,
    `decidedAt`, `decisionInput`, sets `refusal`;
  - `reject(id, decidedBy, reason, at)`: `pending` and not expired → `rejected`;
  - `expire(at)`: every `pending` with `expiresAt <= at` → `expired` (`decidedAt: at`), returns them.
  Times are milliseconds. With several processes the conditions must be checked in the same statement as the
  change (a conditional `UPDATE … WHERE status = 'pending'`), not read then written.
- Persisted inputs and results must be JSON.

## Tests

`npm test -w @astratra/agent` uses `node --test`; the guard tests run on
`@astratra/ai/guards/testing` with no model. Real PostgreSQL tests run only
with `AGENT_TEST_DATABASE_URL` naming a database ending in `_test`; otherwise
that test is skipped (feedback, scheduler lock and approval store tests included). The tests create and drop their own randomly named tables.
