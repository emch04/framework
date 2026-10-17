# @astratra/conscience

[English](README.md) | [Français](README.fr.md)

A documented memory of an AI agent's decisions, kept under a deterministic
governor. The agent records what it decided, why, with which versions and what
it expected; outcomes, human corrections and lessons are attached later, with
their evidence, and nothing is ever silently overwritten. Node >= 20,
CommonJS, MIT.

"Conscience" and "autoconscience" name software functions: a record of
decisions and, later, a reflective engine. They claim no subjective awareness.

```sh
npm install @astratra/conscience
```

The package has three entries:

| Entry | Phase | What it gives |
|---|---|---|
| `@astratra/conscience/governor` | P0, P5 | Deterministic governor: constitution, permissions, budgets, isolation, kill switch, human approval, audit journal; and (P5) approval matrix, reversible versioned changes with progressive rollout, rollback, morning report. Imports Node built-ins only: no language model, no AI package (a test walks its import graph). |
| `@astratra/conscience` | P1 | Decisions, predictions, outcomes with revisions, masked corrections, lessons with evidence, self-model, temporal memory, lineage, erasure, retention, memory guard. |
| `@astratra/conscience/autoconscience` | P2, P3, P4 | Deterministic evaluation: calibration, statistics, conflicts, fidelity, tool reliability, calendars, error costs, counter-metrics and cycle utility; experiments and vigilance (P3); shadow mode (P4). |

## Quick start

```js
const { createGovernor, createPostgresGovernorStore, postgresGovernorSchema } = require('@astratra/conscience/governor');
const { createConscience, createPostgresConscienceStore, postgresConscienceSchema } = require('@astratra/conscience');
const { createRedactor } = require('@astratra/privacy');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(postgresGovernorSchema());
await pool.query(postgresConscienceSchema());

const governor = createGovernor({
  version: '2026-10',
  budgets: { perCycle: 0.5, perAgent: 5, perOrganisation: 20 }, // your cost unit, per day by default
  approvers: ['admin-1']                                         // human identities from your application
}, { store: createPostgresGovernorStore(pool) });

const conscience = createConscience({
  governor,                                // required: refuses to start without one
  masker: createRedactor(),                // required: any (text) => text, or a redactor, or { mask(text) }
  store: createPostgresConscienceStore(pool)
});

const { decision } = await conscience.recordDecision({
  organisationId: 'org-1', userId: 'user-7', agentId: 'billing-assistant',
  objective: 'Remind the customer about invoice 42',
  context: { at: new Date(), summary: 'Invoice 42 is 10 days late' },
  action: { name: 'send_reminder', kind: 'write', input: { channel: 'email' } },
  alternatives: ['wait', { name: 'call', reason: 'outside office hours' }],
  expectedOutcome: { description: 'Invoice paid within 7 days', metric: 'paid', target: true },
  horizon: Date.now() + 7 * 86400000,
  confidence: 0.7,
  permissions: ['invoices:read', 'email:send'],
  versions: { model: 'model-2026-09', tools: { send_reminder: '1.2.0' }, instructions: 'reminders-v3' },
  inputSnapshotRef: 'snapshot://invoices/42'
});

// Three days later, a business sensor reports the real result.
await conscience.attachOutcome({
  organisationId: 'org-1', decisionId: decision.id, status: 'succeeded', sensor: 'payments',
  provenance: { kind: 'sensor', id: 'payments-webhook' }, observedAt: new Date(), sources: ['payments://tx/991']
});
```

## Governor (`/governor`)

The governor decides by code. The same policy and the same proposal always
give the same answer; no model is consulted, and none can approve anything.

### Policy

`createGovernor(policy, { store, now, onEvent })` checks the policy and throws a
`GovernorError` (`policy_missing`, `policy_invalid`) when it is absent or wrong.
The policy is frozen; `getPolicy()` returns a copy.

| Field | Default | Meaning |
|---|---|---|
| `budgets` | required | `{ perCycle, perAgent, perOrganisation, periodMs = 1 day }`, in your cost unit |
| `constitution` | `[]` | Extra `ConstitutionRule`s `{ id, description, protectedScope, owner }`, added to the default ones, which cannot be removed |
| `permissions.modifiable` | the four kinds | What a proposal may target: `instructions`, `threshold`, `tool_description`, `routing` (a subset only) |
| `automaticChanges` | `'none'` | The only mode in this version: every acceptable proposal waits for a human |
| `isolation` | `'organisation'` | An operation touches one organisation only |
| `approvers` | any human | Human identities allowed to approve |
| `halted` | `false` | Static kill switch |

Protected scopes, always in the constitution: `permissions`, `budgets`,
`security`, `privacy`, `constitution`, `approvals`, `isolation`, `governor`. A
custom rule protects a scope name, a `kind:id` target (`routing:payments`) or a
prefix ending in `*`.

### Proposals

```js
const proposal = await governor.evaluatePolicy({
  organisationId: 'org-1',
  target: { kind: 'instructions', id: 'reminders', version: 'v3' },
  change: { text: 'Mention the invoice number first.' },
  justification: 'Fewer follow-up questions.',
  proposedBy: { kind: 'engine', id: 'reflection' }
});
// proposal.status: 'pending_approval' (reason 'human_approval_required') or 'rejected'
```

A proposal is rejected, with reason codes, when it touches a protected scope
(through its target, its declared `scopes` or any key of its `change`), targets
something outside the allowlist, touches another organisation, is malformed,
or arrives while the kill switch is on. Its justification is never read. The
same proposal twice is one record; a different proposal under the same id is
refused (`proposal_conflict`).

`approveProposal(id, { approver, organisationId })` and `declineProposal(...)`
accept a human identity supplied by your application only
(`{ kind: 'human', id }`); a model, the engine, an unlisted person or the
proposer is refused. Approval records a decision; it never applies the change
by itself (see Approvals and Reversible changes below).

### Budgets, isolation, kill switch, audit

- `authorizeSpend({ id, organisationId, agentId, cycleId, cost })` reserves a
  spend when it fits the cycle, agent and organisation budgets. It is
  idempotent by `id`. The PostgreSQL store reserves under an advisory lock
  inside a transaction (with a `pg` Pool), so concurrent spends never pass a
  budget together.
- `assertSingleOrganisation(...ids)` returns the one organisation of an
  operation or throws `cross_organisation`.
- `halt({ by, reason, organisationId? })` stops reflective operations, globally
  or for one organisation; any actor may pull it. `resume(...)` needs a human.
- Every decision of the governor (evaluate, approve, decline, spend, halt,
  resume, register, stage, deploy, promote, rollback, finding) is written to the audit journal before it is returned:
  `listAudit({ organisationId })`.

### Tool policy, calendar budget, tool kill switch (1.3.0)

The rest of the governor decides about changes an agent proposes to itself.
`createToolPolicy` decides about **one call of one tool**, by code, outside any
model. It knows nothing about what a tool does: families, levels, caps and
every word it returns come from your configuration.

```js
const { createToolPolicy, createPostgresGovernorStore, createPostgresToolBudgetStore,
  postgresToolBudgetSchema } = require('@astratra/conscience/governor');

await pool.query(postgresToolBudgetSchema());           // once, idempotent
const policy = createToolPolicy({
  store: createPostgresGovernorStore(pool),             // audit journal + kill switch
  tools: [
    { name: 'read_items',  family: 'catalogue', level: 'read', maxPerRun: 5 },
    { name: 'update_item', family: 'catalogue', level: 'controlled',
      validate: (input) => Number.isInteger(input?.amount),
      overThreshold: (input, settings) => input.amount > settings.maxAmount },
    { name: 'delete_item', family: 'catalogue', level: 'sensitive' }
  ],
  // Read before EVERY call (a database row, a dashboard...). If it throws, the call is refused.
  settings: async ({ organisationId }) => ({ enabled: true, families: { catalogue: true }, budgetLimit: 15000, maxCallsPerRun: 12, maxAmount: 500 }),
  budget: { period: 'month', timeZone: 'Europe/Paris', store: createPostgresToolBudgetStore(pool) },
  emergency: { activateRoles: ['owner', 'support'], releaseRoles: ['owner'] }
});

const run = policy.createRun();                         // counters of one conversation / task
const decision = await policy.decide({ tool: 'update_item', input: { amount: 40 }, run, actor: { kind: 'model', id: 'assistant' } });
// { allowed, decision: 'allowed' | 'pending' | 'refused', code, level, input, budget, auditId, ... }

const done = await policy.execute({ tool: 'read_items', input: {}, run }, (input, { signal }) => fetchItems(input, { signal }));
// Runs only when allowed. done.executed, done.result, done.interrupted.
await policy.recordSpend({ id: 'call-42', amount: 120 }); // whole units (cents), idempotent by id
```

- **Levels** (`TOOL_LEVELS`): `read` runs; `controlled` runs unless it is over its
  own `overThreshold(input, settings, { organisationId, actor })` (sync or
  async, so a cap can be read from your database; a throw or a rejection
  counts as over), or the run read untrusted content
  (`run.markUntrusted()` or `untrusted: true` on the call), then it is `pending`;
  `sensitive` is always `pending`. The policy never runs a pending call: the
  application keeps it and a person decides.
- **Refusal codes** (`TOOL_REASONS`): `emergency_stop`, `disabled`,
  `unknown_tool`, `family_disabled`, `invalid_input`, `budget_exceeded`,
  `cap_reached` (calls per run, or `maxPerRun` of the tool), and
  `settings_unavailable` when settings, kill switch or budget cannot be read.
  Pending codes: `sensitive_tool`, `untrusted_context`, `over_threshold`.
  Order: stop, disabled, unknown, family, input, budget, caps, level. Calls asked
  together are counted at once, so they cannot all slip under a cap.
- **Your words**: `labels: { levels, decisions, codes }` renames what you get
  back (`{ decisions: { pending: 'en_attente' } }`); tools then declare their
  level in your word.
- **Calendar budget** (`createCalendarBudget`, also usable alone): consumption
  counted per `'month'` or `'day'` (or your own function) of a time zone
  (`calendarPeriodKey`), cap and amounts are whole units, never floats (use a
  smaller unit for fractions of a cent). `check()` runs before each call and
  also tests the tool's `estimatedCost`; a consumption lands in the period of
  its own instant, so a call at 23:30 on 31 October in Paris counts for
  October there and for November in UTC. Stores: memory
  (`createMemoryToolBudgetStore`), PostgreSQL (`createPostgresToolBudgetStore`:
  one atomic, idempotent statement, bigint), or your own `{ getSpent(scope,
  period), addSpend({ scope, period, id, amount, at }) }` (idempotent by id).
  The scope is `organisationId` by default. The cap is reached when
  `spent >= limit`; with the measure after the call, the last call may pass it.
  **Read-only (1.4.0)**: a store with `getSpent()` only reads a consumption you
  already count elsewhere (your own table of costs); the budget then only
  checks it before each call, `budget.readOnly` is `true`, and `record()` /
  `recordSpend()` throw `budget_read_only`. `readOnly: true` asserts it.
- **Emergency stop**: `halt({ by, reason, organisationId? })` is read before
  each call and while a tool runs. `execute()` gives the tool an `AbortSignal`
  that aborts at once on a stop in this process, and within `pollMs` (default
  1 s) on a stop pulled by another process; the call is also abandoned if the
  tool ignores the signal (`interrupted: true`). `activateRoles` pull it
  (default: anyone with an id), `releaseRoles` lift it (default: any human; a
  `model` or `engine` actor never can). A `governor` option makes the governor
  kill switch stop the tools too. **`isHalted` (1.4.0)**: an emergency stop kept
  by your application (a column of its settings), a boolean or a function
  `(organisationId) => boolean`, sync or async, read before each call and
  polled while a tool runs; anything but a boolean, or a throw, refuses the
  call (`settings_unavailable`). `validate` may be async too.
- **Audit**: every decision is written to the governor journal before it is
  returned (`tool_decision`: who, tool, family, level, decision, reasons, input
  fingerprint, never the raw input), plus `tool_outcome`, `tool_halt`,
  `tool_resume` and their refusals. If the journal cannot be written the call
  does not run. `onEvent` receives the same records.

### Approvals (matrix, double approval, expiry)

Approval is decided by the policy, not by whoever proposes:

```js
createGovernor({
  budgets: { /* ... */ },
  approvers: ['admin-1', 'admin-2', 'rev-1'],
  approvals: {
    roles: { 'admin-1': ['owner'], 'admin-2': ['owner', 'reviewer'], 'rev-1': ['reviewer'] },
    matrix: { instructions: { roles: ['owner', 'reviewer'] }, routing: { roles: ['owner'], approvals: 2 } },
    floors: { routing: 'high' },   // minimum risk of a kind (default "medium")
    doubleApprovalFrom: 'high',    // from this risk, two distinct people
    distinctRoles: false,          // true: the two must hold different roles
    expiresInMs: 7 * 24 * 3600e3,  // validity of an approval
    declineReasons: ['too_costly'] // added to the register
  }
});
```

- The risk of a proposal is the higher of the floor of its kind and the `risk`
  it declares (`low`, `medium`, `high`, `critical`): a proposer can raise the
  bar, never lower it. `proposal.requiredApprovals` says how many people are
  needed (1, or 2 from `doubleApprovalFrom`, or more by the matrix).
- `approveProposal(id, { approver, organisationId, role? })` records one
  approval. The proposal stays `pending_approval` until it holds enough valid
  approvals from distinct people whose roles the matrix allows; the same
  person cannot approve twice; nobody approves their own proposal.
- An approval expires after `expiresInMs`. An expired partial approval no
  longer counts; an approved proposal nobody staged in time becomes `expired`
  (`expireApprovals({ organisationId })` sweeps them) and must be proposed again.
- `declineProposal(id, { approver, organisationId, reasonCode })` needs a code
  of the register (`DECLINE_REASONS`: `insufficient_evidence`, `risk_too_high`,
  `not_needed`, `wrong_scope`, `poor_tests`, `no_rollback_plan`,
  `conflicts_with_policy`, `bad_timing`, `duplicate`, `other`, plus the codes
  of the policy). Free text goes in `note` and is never interpreted.
- `listRejectionSignals({ organisationId, since?, origin?, reasonCode? })`
  returns every refusal, by a person (`origin: 'human'`) or by code
  (`'governor'`), as a record of codes for the evaluation and experiment phases.
- Invariant: nothing is applied because a model approved it. Approval needs a
  human identity; staging re-reads the stored approvals and refuses anything
  else (a record forced to `approved`, a model approval, a changed content, a
  protected scope, an expired approval). `verifyApprovalInvariant({ organisationId })`
  audits the store for such cases.

### Reversible changes

Objects a proposal may change (instructions, thresholds, tool descriptions,
routing rules) are versioned. The audit journal keeps who, what, when and the
version before and after.

```js
await governor.registerObject({ organisationId, kind: 'instructions', id: 'reminders', content: { text: '...' }, by: { kind: 'human', id: 'admin-1' } }); // v1, stable
const proposal = await governor.evaluatePolicy({ organisationId, target: { kind: 'instructions', id: 'reminders', version: 'v1' }, change: { text: '...' }, proposedBy: engine });
await governor.approveProposal(proposal.id, { approver: human, organisationId });
await governor.stageChange(proposal.id, { organisationId, by: engine });   // candidate v2, exposure 0 %
await governor.deployChange({ organisationId, kind: 'instructions', id: 'reminders', percentage: 10, by: human });
const { versionId, content } = await governor.resolveVersion({ organisationId, kind: 'instructions', id: 'reminders', targetingKey: userId, attributes: { cohort: 'beta' } });
await governor.deployChange({ /* ... */ percentage: 100, by: human });
await governor.promoteChange({ /* ... */ by: human });                      // v2 becomes stable
await governor.rollbackChange({ /* ... */ by: anyActor, reason: 'metrics fell' }); // back to v1, exactly
```

- `stageChange` creates a candidate only from a proposal a human approved, and
  re-checks everything at that moment: fingerprint, protected scopes,
  allowlist, organisation, approvals (human, distinct, roles, count, expiry)
  and that the proposal targets the current stable version (`stale_base`).
  One candidate per object. Staging the same proposal twice is one candidate.
- Exposure grows by decision of a human (`deployChange`, `promoteChange`):
  `percentage` (0 to 100) and/or `cohorts`. Cohorts say who is eligible, the
  percentage which share of them. Buckets use the hashing of
  `@astratra/flags` (`rolloutBucket` is identical to its `bucket`), so a user
  stays in or out consistently, and growing never removes anyone. Promotion
  needs 100 % of everyone.
- To let a real flag service decide, pass `flags` to `createGovernor`: any
  object with `resolveBoolean(key, fallback, context)`, such as an
  `@astratra/flags` provider. This package does not import it.
  `exportFlagRules({ organisationId })` gives the rules to load in its
  `createMemorySource`. A failing flag service serves the stable version.
- `rollbackChange` works at any time, for any identified actor, even while
  halted: it discards the candidate, or restores the version that was stable
  before the last promotion (the same record, not a copy). It is journaled.
- Kill switch: `halt()` also brings every candidate of its scope (global, or
  one organisation) back to its stable version and returns what it reverted.
  While halted, `resolveVersion` serves stable and nothing can be staged,
  deployed or promoted. `resume()` does not bring a candidate back.
- `listVersions`, `getObject`, `listObjects` and `getChangeHistory` read the state.

### Morning review

`recordFinding({ organisationId, code, severity, subject, ... })` receives the
findings of a reflection run (codes and numbers, no sentences).
`morningReport({ organisationId, since, until? })` returns plain data for an
interface to display, the same data for the same store and period:

| Field | Content |
|---|---|
| `findings` | Findings received in the period, counted by severity |
| `pendingProposals` | Waiting for approval: risk, approvals required and valid, allowed roles, tests, rollback plan |
| `approvedAwaitingStage` | Approved, not staged: expiry, `valid`, `expired` |
| `rollouts` | Candidates in deployment: stable and candidate versions, percentage, cohorts |
| `rejections` | Recent refusals as signals with coded reasons |
| `rollbacks` | Recent rollbacks and emergency reverts |
| `counts` | Totals for a header |

The report copies no free text of the proposer, only ids, codes, numbers and the
`tests` and rollback plan objects it supplied. Everything is read inside one
organisation.

### Remote settings (dashboard)

`createRemoteSettings` lets a dashboard turn the agent on or off, pull or
release its kill switch, name its approvers and set its reflection schedule,
and lets humans approve or decline proposals there. The governor stays the only
judge: the adapter turns the settings into governor options and submits each
human decision through `approveProposal` / `declineProposal`. It imports
nothing but this folder: you pass the function that reads the settings.

```js
const { createRemoteSettings, createPostgresGovernorStore } = require('@astratra/conscience/governor');

const remote = createRemoteSettings({
  read: () => dashboard.readSettings(),        // your client, with its own cache
  policy: localPolicy,                         // constitution, permissions, budget CEILINGS
  organisationId: 'org-1',
  storage: { load: () => cache.get(), save: (s) => cache.set(s) } // optional: survives restarts
});
const store = createPostgresGovernorStore(pool);

setInterval(async () => {
  await remote.refresh();                      // never throws
  const governor = remote.governor({ store }); // ask for it each time: rebuilt when the policy changes
  await remote.sync(governor);                 // remote kill switch, applied now
  const results = await remote.applyDecisions(governor, await dashboard.readDecisions());
  // report results back (applied, already_applied, refused + code; failed = retry later)
}, 60_000);

if (remote.reflectionDue()) await runCycle({ cycleId: remote.reflectionCycleId() });
```

Settings (`conscience-settings/1`): `version`, `enabled`, `halted`,
`resumedBy`, `approvers`, `reflection { automatic, hour, timeZone }`,
`cyclesPerDay`. Rules:

| Situation | Effect |
|---|---|
| Source silent, slow or invalid | The last valid settings stay (`source: 'last_known'`), from memory or `storage` |
| Nothing valid ever seen | Everything off: disabled, governor halted, no approver |
| Older `version` than the one in force | Ignored (`stale_settings`) |
| `halted: true` | Applied at once, even inside an invalid or stale answer; `sync` pulls the governor's kill switch (candidates go back to stable) |
| Halt released | `sync` resumes only a halt it pulled, and only as the human named in `resumedBy`; a halt pulled by anyone else stays |
| `enabled: false` | Governor halted; `reflectionDue()` is false |
| `cyclesPerDay` | `perAgent` and `perOrganisation` become `min(local, cyclesPerDay × costPerCycle)`, never above the local values |
| `approvers` | The governor's approvers; within the local `approvers` list when it has one |
| Anything else (`constitution`, `budgets`, `permissions`, `approvals`…) | Never applied, listed in `current().ignored` |

`applyDecisions` is safe to replay: a decision the governor already holds comes
back as `already_applied`, so one approval is never counted twice. Approvers,
halt, protected scopes, roles and expiry are still checked by the governor.

### Bootstrap check

`assertGovernorReady(governor, { organisationId })` throws `governor_missing`,
`governor_invalid` (an object not built by `createGovernor`),
`governor_unavailable` (store unreachable) or `governor_halted`. Every
reflective write of the package calls it first.

## Conscience (main entry)

`createConscience({ governor, masker, store, now, retention, erasers, onEvent })`
throws when the governor or the masker is missing.

### Records

| Method | Record |
|---|---|
| `recordDecision(input)` | `DecisionRecord`: organisation, person, agent, objective, dated context, action, alternatives, expected outcome, horizon, confidence 0–1, permissions, model/tool/instruction versions, input snapshot reference |
| `recordPrediction(input)` | A probability attached to a decision, with its resolution date |
| `attachOutcome(input)` | `OutcomeRecord`: `succeeded`, `failed` or `unknown`, sensor, sources, uncertainty, confounders, provenance. A later outcome from the same sensor is a new revision; earlier ones are kept |
| `recordCorrection(input)` | `CorrectionRecord`: only the masked word difference between the proposed and final texts is stored, with its class (`factual`, `style`, `objective`, `disagreement`) and the author's role |
| `recordLesson(input)` | `MemoryLesson`: evidence, degree, `validFrom`/`validUntil`, status, contradictions, replacements. Reflective write |
| `updateSelfModel(input)` | `SelfModelSnapshot`: tested capabilities (each with evidence), tools, limits, permissions, provenance. Reflective write |

Every record has a stable id: pass your own, or it is derived from the
content, so recording the same thing twice gives one row. Records are never
updated; revisions are new rows.

Free text (objective, context, action input, expected outcome, observations,
lesson summaries and notes, corrections) goes through the masker before it is
stored. Use a deterministic masker.

### Evidence register

A lesson without evidence is always a `hypothesis` (`statusForced: true` when
another status was asked). Evidence that points to a decision, prediction,
outcome or correction must exist in the same organisation. This version stores
lessons and their history; P2 checks sample sufficiency and open contradictions
before a lesson can be verified.

### Reading

- `getDecision(scope, id)`, `recallDecisions(scope, { agentId, from, to, asOf, withOutcomes })`
- `getOutcomes(scope, decisionId)`: every revision with `revision`, `current`, `supersededAt`
- `getLesson(scope, lessonId)`, `listLessons(scope, { status, validAt, asOf })`
- `getSelfModel(scope, agentId, { asOf })`, `getSelfModelHistory(scope, agentId)`
- `getMemoryTimeline(scope, { axis: 'event' | 'recorded', from, to, asOf, validAt, kinds })`:
  event time, recording time and validity period. `asOf` answers "what did
  we know at that time".
- `getLineage(scope, decisionId)`: objective → action → tools → outcomes →
  corrections → lessons.

A scope is `{ organisationId, userId? }`. A record of another organisation (or
another person, when `userId` is given) is answered exactly like a missing one.

### Memory guard

Stored text is untrusted data: it may come from a person, a tool or a
manipulated model. The package never interprets it, and the governor never
reads it. Before a model reads records, frame them:

```js
const { frameRecordsForModel } = require('@astratra/conscience');
const block = frameRecordsForModel(await conscience.listLessons({ organisationId: 'org-1' }));
```

The framing is the one of `@astratra/ai/guards` (random marker the content
cannot close).

### Erasure and retention

`eraseSubject({ organisationId, userId })` removes the person's decisions,
predictions, outcomes, corrections and lessons, removes references to them
from the organisation's lessons (a lesson left without evidence becomes a
hypothesis again), and calls your `erasers` for data kept elsewhere (vectors,
indexes, caches, calibrations). It returns a report with counts. With
`retention: { erasure: 'anonymise' }` the records are kept without the person.

Nothing is deleted on a timer. `applyRetention({ organisationId })` removes
records older than `retention.maxAgeDays[kind]`, and only for the kinds you
configured.

## Stores

Memory stores (default, lost on exit) and PostgreSQL stores are included. SQL
uses parameters only; the table prefix is a checked identifier.

```js
postgresConscienceSchema({ prefix: 'astratra_conscience' }) // table <prefix>_records
postgresGovernorSchema({ prefix: 'astratra_governor' })     // <prefix>_proposals, _audit, _spend, _controls, _objects, _versions, _findings
postgresToolBudgetSchema({ prefix: 'astratra_tools' })       // <prefix>_budget_totals, _budget_entries (tool budget, 1.3.0)
```

### Writing your own store (MongoDB, ...)

A conscience store has five methods on immutable envelopes
`{ kind, id, organisationId, userId, agentId, decisionId, lessonId, eventAt, recordedAt, fingerprint, evidenceRefs, data }`:

| Method | MongoDB sketch |
|---|---|
| `put(envelope)` | `insertOne` with a unique index on `{ organisationId, kind, id }`; on duplicate key return the existing document with `created: false` |
| `get(kind, organisationId, id)` | `findOne` |
| `list(kind, filter)` | `find` on the indexed fields, `recordedAt <= recordedTo`, `evidenceRefs: ref`, sorted by `recordedAt` then insertion |
| `replace(envelope)` | `replaceOne` (erasure and retention only) |
| `remove(kind, organisationId, ids)` | `deleteMany`, returns the count |

`matchesFilter(envelope, filter)` gives the exact filter semantics. The
governor store interface (`GovernorStore` in the types) needs an atomic
`reserveSpend` (a transaction), a compare-and-set `transitionProposal`
(`findOneAndUpdate` on `status`, and on the number of approvals when a `guard`
is given), a compare-and-set `updateObject` on `revision`, and insert-once
`createObject`, `putVersion` and `putFinding`.

## Autoconscience (`/autoconscience`)

The P2 core is deterministic and imports no language model. `evaluateOutcomes()`
(and its alias `runReflection()`) reads P1 records and returns `ReflectionFinding[]`.
`createEvaluator({ governor, conscience, ...defaults })` binds an evaluator;
`evaluate({ organisationId, userId?, agentId?, window?, ...options })` evaluates
one scope. All reflective entries check `assertGovernorReady`; evaluation has
no storage writes, generated text or automatic action.

```js
const { evaluateOutcomes } = require('@astratra/conscience/autoconscience');
const findings = await evaluateOutcomes({
  governor, conscience, organisationId: 'org-1', agentId: 'billing-agent',
  minimumSample: 30, buckets: 10, level: 0.95,
  errorCostPolicies: [{ organisationId: 'org-1', domain: 'billing', falsePositive: 1, falseNegative: 20 }],
  calendars: [{ organisationId: 'org-1', domain: 'billing', name: 'business',
    periods: [{ label: 'closure', kind: 'closure', from: '2026-12-24', to: '2027-01-02' }] }]
});
```

### Structured inputs

- Decisions accept `domain` (default `general`), `justification: { claims: ['source_verified'] }`
  and actual `toolTrace: [{ callId, tool, provider?, status, empty?, durationMs, labels? }]`.
  A declared list of tools is not an execution trace. Labels such as `source_verified`
  must come from your instrumented application, not from generated prose.
- Predictions accept `domain` (inherited from the decision) and an optional `sensor`.
  Outcomes accept `predictionId`, checked against the decision in the same organisation.
- Corrections accept an application `class` or structured `tags`: `fact_changed`,
  `wording_changed`, `goal_changed`, `opinion_changed`. Explicit class wins;
  absent, unknown or conflicting tags become `disagreement`. Text is never classified
  by a model or interpreted as a command.
- Lessons accept `domain`, `subject` and `stance: 'supports' | 'opposes'`.
  Opposing positions within the same organisation, person, agent and domain open
  a symmetric conflict (`to_reassess`). Textual summaries alone cannot establish opposition.

### Calculations and contracts

| Function | Result |
|---|---|
| `honestStatistics(statuses, options)` | Known sample size, unknown count, success rate, Wilson interval, `insufficient_data` below `minimumSample` (30 by default), refusal to conclude |
| `wilsonInterval(successes, total, level)` | Two-sided Wilson score interval; levels 0.90, 0.95 (default), 0.99; null only for zero known observations |
| `calibratePredictions(points, options)` | Per agent/domain reliability curve, Brier score, signed confidence gap, overconfidence and underconfidence; empty bins have null means |
| `scoreErrorCosts(points, policy, options)` | False positive/negative counts, total cost and `weightedScore = totalCost / knownCount` in your cost units; threshold 0.5 by default |
| `checkReasoningFidelity(justification, traces, claimRules)` | `faithful`, `unfaithful` or `unknown`; every required label needs a successful, nonempty call; default rule requires `source_verified` |
| `toolReliability(traces, options)` | Per tool/provider error, empty and slow rates, their Wilson intervals and minimum samples, nearest-rank p95; slow means duration strictly above `slowMs` (5000 by default) |
| `calendarConfounders(domain, at, calendars)` | `calendar_confounded` for dates in a declared half-open period `[from, to)` |
| `checkCounterMetrics(target, counters)` | Target improvement rejected if any counter-metric regresses strictly beyond its `maxRegression`; thresholds use absolute metric units |
| `classifyCorrection(input)` | Deterministic classification; only `factual` corrections can support a factual lesson |
| `evaluateLessonConflicts(lessons, options)` | Open conflicts with evidence ranking and dates; stronger evidence can suggest a preferred lesson, a newer date alone never resolves one |
| `reflectionUtility(run, options)` | Useful findings + accepted proposals (configurable weights) minus weighted cost; usefulness requires positive benefit and positive net utility |
| `recommendReflectionFrequency(runs, options)` | `reduce` after `uselessCycles` consecutive useless completed cycles (default 3); interval multiplier `reductionFactor` (default 2) |

Cycles without measured useful-finding or accepted-proposal counts remain
`unmeasured`; they do not count as useless cycles. Unknown tool-call statuses
stay outside the error-rate denominator (empty and slow rates describe actual
reported emptiness and durations).

Unknown outcomes never enter success/failure denominators or Brier/cost scores.
Evaluation uses the latest prediction per decision/domain (date, then id), and
the current outcome for its sensor or explicit prediction link. Missing or
ambiguous matches, or predictions made after the observation, remain unknown.
One decision contributes at most one calibration point per domain; duplicate
points supplied directly to `calibratePredictions` are rejected. The curve's
bins also expose their own sample adequacy. Scores below the threshold remain
descriptive; they are not rules or causal evidence.

Findings contain stable ids, evidence references, sample size, interval, status,
confidence, confounders and competing explanations. The core always emits
`causality: 'not_established'`: an outcome and the fidelity of its method remain
separate. A lucky success never creates a general rule. `confidence` describes
the supplied observation confidence or interval level, not the probability that
a causal hypothesis is true. Intervals remain visible for small nonzero samples
while `insufficient_data` explicitly refuses inference.

### Lesson verification and arbitration

`createConscience({ minimumSample: 30, ... })` controls the verification floor;
a lesson may request a higher `minimumSample`, never lower that floor.
Verification counts **distinct decisions** represented by current known outcomes
or factual corrections in the lesson's domain and agent scope. Decision-only,
prediction-only and external references do not inflate the observed sample;
unknown or superseded outcomes and duplicate references do not count. A factual
lesson citing a style/objective/disagreement correction remains a hypothesis.
Evidence existence, sufficient sample and no open contradiction are all required
for `verified`; open conflicts produce `to_reassess`, other cases `hypothesis`.
This is an evidence sufficiency status, not a proof of a causal assertion.

`conscience.resolveLessonConflict({ organisationId, userId?, winnerId, loserId, evidence })`
is an explicit application arbitration: it requires sufficient factual evidence
in the same domain, retires the opponent and appends a new revision of the winner.
All writes pass through `assertGovernorReady`. Earlier revisions are retained.
`getLesson().current` and `listLessons()` reassess evidence and conflicts, including
late unknown outcomes and concurrent conflicting writes. `storedStatus` exposes
the recorded status; `getLesson().history` retains recorded revisions. `asOf`
uses the evidence and outcomes known at that recording date.

Findings and calibration are recalculated rather than cached or persisted:
erasing their source records removes them from subsequent evaluations. If your
application stores findings elsewhere, register an eraser for that store.
Windows filter decision dates; they do not implement P3 time-frozen replay.
A query reaching 1000 decisions refuses with `evaluation_limit`: supply explicit
`decisionIds` for a larger selection, rather than silently evaluate a partial sample.

P3 experiments and P4 shadow mode are described in their own sections below.
Evaluation itself does not create a scheduler, a model transport or a deployment.

- P3, experiments: time-frozen replay that refuses future data, sandbox,
  protected test set. Drift monitoring, follow-ups, abstention, the night
  adversary, multi-role review and lessons turned into tests are described in
  "P3 · vigilance (2/2)" below.
- P4, shadow mode in a sandbox: see "P4 · shadow mode" below.
- Only P6 (integration and guarded transfer between agents) remains outside this package.

P5 (advanced governance) is in the governor entry: see above.

## P3 · experiments (1/2)

The first half of P3 implements proposals 02/35 (temporal replay), 32
(simulated tools), 36 (protected final set) and 16 (preregistered experiments).
The package stays at the unreleased version 1.0.0. All five API entries and
their later operations check `assertGovernorReady`; scope is one organisation.
The scoring core imports no language model and never uses generated text as a
judge. Remaining P3 capabilities belong to the second half.

| API | Contract |
|---|---|
| `replayDecisions({ governor, conscience, organisationId, proposal, decisionIds \| window, asOf, snapshots?, tools? })` | Reconstructs inputs and current outcome/lesson revisions known **at each decision**, with `asOf` as the outer cutoff. Refuses detected future information with `future_data`. Returns `purpose: 'compatibility_only'`, `provesProgress: false`, and `causality: 'not_established'`. |
| `createSandbox({ governor, organisationId, tools })` | Replaces every implementation, including real read functions. Reads return static `response`, matching `recordings: [{ input, output }]`, or a simulated unknown. Writes/confirmations only append intentions; bare real functions are conservatively treated as writes. `tools[name](input)` and `getJournal()` never call real tools. |
| `createHoldout({ governor, organisationId, cases })` | Provisioning creates an opaque handle: only `evaluate`, `getAccessLog`, and a denied `read` operation. Properties, enumeration and serialization cannot reveal contents (`holdout_protected`). One final evaluation only, including concurrent attempts. |
| `proposeExperiment({ governor, organisationId, hypothesis, metrics, protocol, thresholds, agent, holdout, tools? })` | Deep-copies and freezes registration before any candidate execution: hypothesis, metrics, protocol, thresholds, timestamp, SHA-256 fingerprint, candidate/tool fingerprints. Reserves an unused final set. |
| `runExperiment({ governor, organisationId, experiment })` | Executes the registered candidate once on development, then validation, then the protected final set. Changes to the protocol, metrics, thresholds, hypothesis, candidate or tools are refused with `protocol_changed`, including changes after execution. |

```js
const { createHoldout, proposeExperiment, runExperiment } = require('@astratra/conscience/autoconscience');
const binding = { governor, organisationId: 'org-1' };
// Supply these three disjoint sets from trusted provisioning code.
// Each case is { id, input, expected }; reflection never receives finalCases.
const holdout = await createHoldout({ ...binding, cases: finalCases });
const experiment = await proposeExperiment({
  ...binding, hypothesis: 'The candidate meets the registered accuracy floor',
  agent: (input) => input, // self-contained evaluated function
  metrics: [{ name: 'accuracy', kind: 'exact_match' }],
  thresholds: { accuracy: 0.9 },
  protocol: { development: developmentCases, validation: validationCases,
    minimumSample: 30, level: 0.95, timeoutMs: 1000 },
  holdout
});
const result = await runExperiment({ ...binding, experiment });
// result.decision: supported | refuted | inconclusive
// result.stages.holdout: aggregate metrics only, no cases, answers or journal.
```

Metrics use deterministic JSON equality (`kind: 'exact_match'`). Optional
`outputKey` / `expectedKey` select structured fields. No evaluator callback can
read final answers. P2 `honestStatistics` supplies known/unknown counts and
two-sided Wilson intervals (minimum 30; levels 0.90, 0.95, 0.99). A missing
output, execution failure or timeout is unknown. A decision is `supported`
only when **every metric in every stage** has sufficient observations and an
interval entirely at or above its threshold; `refuted` requires a sufficient
interval entirely below a threshold; insufficient data, unknowns or an interval
crossing a threshold are `inconclusive`. These are threshold tests, not a
claim of causal improvement over a baseline. `interval` is the first final
metric's interval; all intervals are in `stages.*.metrics`. Case ids and input
fingerprints must be distinct across splits; repeated inputs cannot inflate a
sample. Development/validation intentions are journaled; final intentions and
individual outputs are not exposed.

A replay `proposal` is `{ agent, information?: [{ organisationId, userId?, at,
recordedAt, data }] }`. `snapshots` maps `inputSnapshotRef` to the same dated
shape; a referenced snapshot is mandatory (`snapshot_missing`). Without a
reference, the stored dated context is the snapshot. The candidate receives
`{ inputs, outcomes, lessons, information, decision, asOf }`; `decision` contains
only id, objective, context, versions and permissions, never the original
action or expected answer. Compatibility compares its output to
`{ name: originalAction.name, input: originalAction.input }`. Outcome and lesson
revisions recorded later are excluded; an early-recorded but future-dated fact
is refused. Historical lesson evidence is checked too; undated external
evidence is refused (`temporal_evidence_required`). Factual timestamps,
including nested ones and simulated responses, are validated. Replay read responses
require `{ organisationId, userId?, at, recordedAt, data }`
(`temporal_metadata_required` without dates); planned horizons
and expiry dates are not treated as future observations. Snapshot dates must
be truthful: the library cannot infer undeclared provenance or whether literal
knowledge embedded in candidate source came from the future. Selections are
bounded rather than silently truncated (`replay_limit`).

Candidates are serialized from function source and executed in fresh worker
realms with only JSON data and simulated tools. They cannot access host
closures, `process`, `require`, `fetch`, filesystem, dynamic imports or host
callbacks. Async computations using simulated tools are supported. An injected
model may compute the evaluated agent's output as a self-contained function;
remote model transports and captured model clients cannot run in this sandbox.
The core never chooses or calls a model to decide the score. Worker timeouts
(10–30000 ms per case), memory and output limits bound execution. This is an
application execution boundary for supplied candidate code, not an OS security
boundary for arbitrary hostile native code.

Provisioning code must keep original final cases outside reflection; a handle
cannot protect copies already shared by the application. A final set is
single-use to prevent adaptive probing, and is consumed even on failed
execution. Registration handles, final contents and access logs are local to
the process and are not restartable; audit metadata and aggregate results are
recorded as governor findings (`experiment_registered`, `experiment_started`,
`experiment_completed` / `experiment_failed`) in its memory or PostgreSQL
store. No new SQL schema or dependency is needed. Real PostgreSQL tests run
with `CONSCIENCE_TEST_DATABASE_URL=postgresql://localhost/conscience_p3a_test`;
P3 integration tests fail, rather than skip, if an explicitly supplied test
database is unavailable. Run the mutation proof separately with
`node packages/conscience/test/experiments-mutations.js`.

## P3 · vigilance (2/2)

Second half of P3, in `@astratra/conscience/autoconscience`: six deterministic
modules that watch, remind, hold back, challenge, cross-check and turn lessons
into tests. None imports a language model (a test reads the sources), and none
applies anything: every change goes through a proposal to the governor, and
every call first checks that the governor exists, is genuine and is not halted
(`assertGovernorReady`).

| No. | Function | What it does |
| --- | --- | --- |
| 17 | `detectDrift` | Drift watch on inputs, outcomes and performance, with a coded recommendation. |
| 18 | `createFollowUps` | Prospective memory: `scheduleFollowUp`, `dueFollowUps`. |
| 26 | `abstentionPolicy` | Confidence threshold from calibration and error costs. |
| 27 | `generateAdversarialCases` | Candidate trap scenarios from recent failures. |
| 14 | `reviewByRoles` | Verifier, contradictor and risk controller, reviewed apart. |
| 03 | `lessonToScenario` | A verified lesson becomes an anti-regression scenario. |

### Drift watch (17)

```js
const report = await detectDrift({
  governor, organisationId, agentId, domain,
  baseline: { window: { from, to }, inputs: { domains, languages, lengths },
              outcomes: { succeeded, failed, unknown },
              performance: { calibration: { sampleSize, brierScore, confidenceGap }, tools: [{ tool, provider, knownCalls, failures }] } },
  current: { /* same shape */ },
  calendars,            // P2 DomainCalendar[] of the same organisation
  recentChange,         // { kind, id, version, previousVersion, deployedAt }
  propose: {}           // optional: a rollback recommendation becomes a PENDING proposal
});
```

`snapshotWindow({ decisions, findings, agentId, domain, languageOf })` builds a
summary from P2 material (the core detects no language: `languageOf` is yours).

Tests, simple and documented in the source: the Population Stability Index for
distributions (domains, languages, lengths cut at the baseline quintiles; a 0.5
pseudo-count per category; below 0.10 stable, 0.10 to 0.25 moderate, 0.25 or
more significant) and the difference of two proportions with Newcombe's hybrid
score interval, built from the Wilson intervals of P2 (outcome success rate,
share of unknown, tool error rate). A shift is significant when the interval
excludes zero and the gap is at least 5 points (`minimumEffect`). Brier score
and confidence gap are compared with a threshold (`brierDelta`,
`confidenceGapDelta`). A window with fewer than `minimumSample` known
observations never concludes: `insufficient_data`.

A **business calendar** is read before the agent is blamed: a period that
overlaps the current window and not the baseline one explains the shift
(`attribution: 'calendar'`, recommendation `monitor`, `reexamineAfter`).

Coded recommendation: `monitor`, `investigate` (inputs moved or a tool decayed
together with a decline), `freeze` (severe unexplained decline, `freezeDrop`),
`propose_rollback` (decline in a window that starts after a recent change, inputs
stable). The report always says `applied: false`. With `propose`, a rollback
becomes a pending proposal at the governor (high risk, two approvals by default)
and still nothing is rolled back: a human decides, then `rollbackChange` is yours
to call. `recordedBy` also files a finding for the morning report.

### Prospective memory (18)

```js
const vstore = createMemoryVigilanceStore();          // or createPostgresVigilanceStore(pool)
const conscience = createConscience({ governor, masker, erasers: [followUpEraser(vstore)] });
const followUps = createFollowUps({ governor, conscience, store: vstore, masker });
await followUps.scheduleFollowUp({ organisationId, decisionId, observableAt, question });
const due = await followUps.dueFollowUps({ organisationId });   // { followUp, decision }[]
await followUps.completeFollowUp({ organisationId, id });
```

Idempotent: the same decision, date and question give the same follow-up
(`created: false`). The question is masked before storage. The decision must exist
in the organisation (another organisation's decision: `not_found`). Follow-ups
are erased with the person through `eraseSubject` (register `followUpEraser`);
a follow-up whose decision was erased or expired is never returned as due. The
content of a due item is data, never an instruction.

### Abstention (26)

`abstentionPolicy({ governor, organisationId, agentId, domain, calibration, errorCosts, currentThreshold, propose })`.
Acting is worth it when the chance of success is at least
`falsePositive / (falsePositive + falseNegative)` (the cost table of P2). The
threshold is the lowest announced confidence, with observations of its own, from
which the lower Wilson bound of the observed success rate stays above that
ratio, over at least `minimumSample` decisions. Not enough data or no cost table:
a prudent default (0.8), never lower than the threshold already in force. No
reliable region: 1. `shouldAbstain(policy, { confidence, actionKind })` answers
`proceed`, `ask_clarification` or (for `write` and `confirm` actions)
`propose_verification`, always from the threshold **in force**
(`effectiveThreshold`). A new threshold is a proposal on target
`threshold:abstention:<agent>:<domain>`; nothing is applied here.

### Night adversary (27) and lessons turned into tests (03)

```js
const library = createScenarioLibrary({ governor, store: vstore, masker });
const { candidates, rejected } = await generateAdversarialCases({ governor, organisationId, failures, masker, generator, library });
const lessonCase = await lessonToScenario(lesson, { governor, masker, question, tools, expect, library });
// later, after humans approved the proposals at the governor:
const suite = (await library.approved({ organisationId })).map((a) => a.scenario);   // for evaluateAgent
```

`generateAdversarialCases` turns recent failures into candidates of four
categories (injection, ambiguity, edge case, access to another organisation) in
the format of `evaluateAgent` from `@astratra/testkit`: `id`, `question`,
simulated tools (fixed results, no effect), `expect`, and a `score` that fails
the case when a forbidden tool is called or a forbidden text appears. An
**injected generator** may write the cases (a function that returns data only;
what it returns is validated, masked, and replaced by the template if invalid or
failing). Without one, deterministic templates are used, the same failure giving
the same cases. The **masker is required** and runs on failures and on whatever
the generator returns.

`lessonToScenario` accepts a lesson whose status is `verified` (evidence, enough
distinct decisions, no open conflict); a hypothesis, a lesson to reassess or a
retired one is refused (`lesson_not_verified`). The lesson says what was learned;
you describe how to check it, and a scenario that asserts nothing is refused.

Every candidate is born `to_review`. With a library it becomes a proposal at the
governor (target kind `instructions`, id `scenarios:<agent>`, configurable with
`targetKind`). `library.approved()` is the **only** way into the test suite: it
keeps a candidate only when humans approved that exact content (same
fingerprint) and the stored content is unchanged. A model, a decline, an expired
approval or an altered candidate keep it out.

### Multi-role review (14)

```js
const review = await reviewByRoles({ governor, organisationId, finding, roles: { verifier, contradictor, riskController } });
review.advances; review.status;   // true / 'supported', or false / 'hypothesis' with review.blockers
```

Three separate functions, not a vote of models. The finding moves forward only
if the verifier cites **independent** evidence (not the finding's own evidence or
decisions, same organisation, optionally confirmed by `evidenceExists`), if no
competing explanation of the contradictor is as strong as the finding's
confidence, and if the risk controller approves a scope at least as wide as the
requested one (`observation` < `agent` < `domain` < `organisation`). A role that
throws or answers badly blocks the finding. Roles receive a frozen copy of the
finding, never each other's answers.

### Storage

`createMemoryVigilanceStore()` and `createPostgresVigilanceStore(db, { prefix })`
(schema: `postgresVigilanceSchema({ prefix })`, tables `<prefix>_follow_ups` and
`<prefix>_candidates`). Same contract, same tests, every access scoped by
organisation, every value a SQL parameter.

## P4 · shadow mode

Proposals 21 (shadow mode) and 32 (sandbox of the shadow mode), in
`@astratra/conscience/autoconscience`. A candidate strategy that humans already
approved processes a share of the real requests **in silence**, next to the
stable strategy. Its answers go to nobody. They are compared with the stable
answers by deterministic metrics you provide, and the gap is kept, masked, as a
`ShadowRun`. No language model is imported (a test reads the sources); every
call first checks `assertGovernorReady`.

```js
const { createSandbox, createShadowRunner, createMemoryShadowStore, shadowEraser } = require('@astratra/conscience/autoconscience');

const sandbox = await createSandbox({ governor, organisationId, tools: {
  lookup_invoice: { kind: 'read', response: { status: 'unknown' } },   // simulated or recorded
  send_reminder: { kind: 'write' }                                      // never executed, only journalled
} });
const shadow = await createShadowRunner({
  governor, organisationId,
  candidate: { kind: 'instructions', id: 'reminders', agent },          // or { proposalId, agent }
  sandbox, sampleRate: 0.1,
  budget: { maxRuns: 500, maxCost: 50, costPerRun: 0.1 },
  masker,                                                               // required
  store: createMemoryShadowStore(),                                     // or createPostgresShadowStore(pool)
  metrics: [
    { name: 'accuracy', score: ({ input, output }) => output.total === input.expected },
    { name: 'sources_accuracy', score: ({ output }) => output.sourced === true, maxRegression: 0.02 },
    { name: 'minor_protection', critical: true, score: ({ input, output }) => !(input.minor && output.disclosed) }
  ],
  target: 'accuracy', minimumSample: 30
});

// In the request path: answer with the stable strategy, then hand over. Never await `done`.
const answer = await stable(request);
respond(answer);
shadow.observe({ request: { id: request.id, userId: request.userId, input: request.input }, stableResult: { output: answer, durationMs, cost } });

const report = await shadow.report({ propose: {}, recordedBy: { kind: 'system', id: 'shadow' } });
report.conclusion;   // 'insufficient_data' | 'regression' | 'no_difference' | 'promising'
```

**Which strategy may run.** Either the candidate version of a governor object
(`{ kind, id }`: the version staged from a proposal that humans approved) or a
proposal in the `approved` state with human approvals (`{ proposalId }`). A
pending, declined, rejected or expired proposal, a stable version, an unknown
object or another organisation's object are refused (`candidate_not_approved`,
`candidate_not_staged`, `not_found`). The check is repeated before every run: a
candidate that was rolled back, promoted or replaced stops the shadow.

**The candidate answer is never returned.** `observe` is synchronous, never
throws and never waits: it returns `{ scheduled, reason, done }`, and `done`
(which never rejects) resolves to an acknowledgement (`recorded` with a run id,
or `skipped`, `timeout`, `error` with a reason) that carries no output of the
candidate. The run happens in the background, after the stable answer. A failing,
slow or hostile candidate, a failing store or masker, a metric that throws: all
are isolated and counted (`stats()`), none reaches the caller. A deadline
(`deadlineMs`) abandons a stalled run, and `maxConcurrent` skips a burst as
`busy` rather than queue it.

**Sandbox only (32).** The candidate is a self-contained function run in the P3
sandbox: no host object, no `process`, no `require`, no timer, no `fetch`. Its
tools are the ones of the sandbox: a read returns a recording (the optional
`recordings` of `observe`, for example what the stable run read) or a simulated
answer; a write is **never executed**, even when the candidate calls it, and is
only journalled as an intention (`writeIntentions`, masked). The shadow opens no
network connection of its own. A model call inside a candidate is a sandbox
tool, replayed or simulated, never a live call.

**Sampling, budget, kill switch.** A request is selected by a hash of its id and
of the shadow id: the same request always gives the same choice, whatever the
order, and `sampleRate: 0.1` selects a subset of what `0.5` selects. The budget is
required and capped: `maxRuns`, `maxCost` (`costPerRun` is the ceiling reserved
for a run, `costOf` can only lower it), `maxDurationMs` (measured time, which the
runs already in flight can overshoot), and `governorAgentId` to spend through
`governor.authorizeSpend` as well. When the budget is spent, or the governor kill
switch is on, the shadow stops at once, stays stopped (releasing the switch does
not wake it: start a new one) and a run that finishes after the stop is
dropped. Budgets count the runs already stored, so a restart continues the same
shadow.

**ShadowRun.** Per sampled request: the masked request, the masked candidate and
stable outputs (replaced by a fingerprint beyond 20 000 characters), the score of
each side for each metric (`succeeded`, `failed`, `unknown`), whether both
answers agree, the write intentions, duration, cost and incidents
(`candidate_failed`, `candidate_timeout`, `scoring_failed`, ...). The raw request
id is not kept. A masker that fails keeps the run out of the store. A candidate
that produces nothing fails the metrics: it cannot have succeeded.

**Report.** Per metric, the success rate of each side with its Wilson interval
and minimum sample (P2: below it, `insufficient_data` and no difference), the
paired counts, and the difference (candidate minus stable) with a Newcombe
interval. Anti-Goodhart (P2): the `target` metric must improve while every other
metric stays within its `maxRegression` (and `limits.cost`); at least one
counter-measure is required when the shadow is built. Critical metrics list the
requests where the stable strategy succeeded and the candidate failed. The
conclusion is a code, in this order:

| Conclusion | When |
|---|---|
| `regression` | More critical regressions than `maxCriticalRegressions` (0 by default; even a single case counts, whatever the sample), or, with enough data, a significant decline of a metric, a counter-measure beyond its limit, or an incident rate significantly above `maxIncidentRate`. |
| `insufficient_data` | Fewer than `minimumSample` runs, a metric with too few known scores, or a cost limit without the stable cost. |
| `promising` | The target improved with an interval above zero and every counter-measure held. |
| `no_difference` | Enough data, no significant difference and no regression. |

It never says "proven": `provesImprovement` is always `false`, `causality` is
`not_established`, `applied` is `false`. A shadow comparison on a sample of real
requests can make an improvement promising, nothing more. With `propose`, a
promising result becomes a **pending proposal** at the governor (target kind of
the candidate, id `shadow:<id>:<version>`); with `recordedBy` any conclusion is
filed as a finding for the morning report. Deploying and promoting stay with a
human (`deployChange`, `promoteChange`): the shadow never calls them.

**Isolation and erasure.** Every row belongs to one organisation and every read
and write is scoped by it; a candidate, a sandbox or a store call of another
organisation is refused. Runs carry the `userId` of the request: register
`shadowEraser(store)` in `createConscience({ erasers })`, or call
`shadow.eraseSubject`, to delete them with the person.

**Storage.** `createMemoryShadowStore()` and `createPostgresShadowStore(db, { prefix })`
(schema: `postgresShadowSchema({ prefix })`, table `<prefix>_runs`). Same
contract, same tests, every value a SQL parameter.

## MongoDB storage

Install the optional peer dependency only when using MongoDB:

```sh
npm install mongodb
```

Both stores accept a native driver `Db`. They never import the driver or open a
connection themselves. With mongoose, wait for the connection, then pass
`connection.db`; pass `connection.getClient()` as `client` for the governor.
The driver is an optional peer (`^6.0.0 || ^7.0.0`), with no mandatory runtime
installation and no mongoose dependency.

```js
const { MongoClient } = require('mongodb');
const { createMongoGovernorStore, mongoGovernorIndexes, createGovernor } = require('@astratra/conscience/governor');
const { createMongoConscienceStore, mongoConscienceIndexes, createConscience } = require('@astratra/conscience');

const client = new MongoClient(process.env.DATABASE_URL);
await client.connect();
const db = client.db();
await mongoGovernorIndexes(db, { prefix: 'app_governor' });
await mongoConscienceIndexes(db, { prefix: 'app_memory' });
const governor = createGovernor({
  budgets: { perCycle: 1, perAgent: 5, perOrganisation: 20 }
}, { store: createMongoGovernorStore(db, { prefix: 'app_governor', client }) });
const conscience = createConscience({
  governor, masker: (text) => maskInApplication(text),
  store: createMongoConscienceStore(db, { prefix: 'app_memory' })
});
```

The index functions are explicit, idempotent migrations; call them before using
the stores. Prefixes accept letters, digits and underscores, begin with a
letter or underscore, and contain at most 41 characters. Defaults are
`astratra_governor` and `astratra_conscience`. Governor collections have suffixes
`proposals`, `audit`, `spend`, `controls`, `objects`, `versions`, `findings`,
`sequences`, `locks`; decision memory uses `records` and `sequences`.

Identity is encoded in the unique `_id`: organisation plus record id (and kind
or version where needed). Inserts return existing content unchanged; approval
transitions compare status and approval count atomically, and object updates
compare revision. Audit ids are unique and a persistent counter orders entries.
Records use a persistent counter to order equal timestamps; replacement keeps
that order. Filters, retention and `conscience.eraseSubject()` use the same
contract as the PostgreSQL store, including organisation isolation and evidence
invalidation. Erasure affects decision memory; governor audit retention remains
application policy, as with PostgreSQL.

**Atomic spending requires a replica set or sharded cluster** (MongoDB 4.2+,
subject to the driver's server compatibility). Each reservation updates an
organisation lock inside a snapshot transaction, with majority write concern.
Conflicting transactions retry through the driver, preventing two concurrent
reservations from exceeding a budget. A standalone server fails spending; there
is no unsafe fallback. Pass the client owning `db` if supplying `client`.
Connections and sessions are caller-owned except the short-lived reservation
sessions, which the store closes. The stores do not make an entire governor
operation transactional: state and audit writes remain separate, as in the
PostgreSQL implementation. Database errors propagate; they never authorize a
spend. MongoDB's normal document size limits apply to individual records.

The shared governor, approval/change, conscience and evaluation contract suites
run against a fake client and, optionally, real MongoDB:

```sh
npm test -w @astratra/conscience
MONGO_TEST_URL=mongodb://127.0.0.1:27017/conscience_test?replicaSet=rs0 npm test -w @astratra/conscience
```

Without `MONGO_TEST_URL`, real MongoDB tests skip with a reason. A supplied URL
must connect to a replica set or sharded cluster; connection or topology errors
fail the suite. Tests create random collection prefixes and drop only their own
collections, never the database. A local `mongodb-memory-server` replica set
can supply the same URL. The vigilance and shadow stores retain their existing
storage adapters; these two MongoDB stores cover the governor and decision
records only.

Mutation checks (three regressions, each detected, then restored):

```sh
node packages/conscience/test/mongo-mutations.js
```

## Tests

```sh
npm test -w @astratra/conscience
CONSCIENCE_TEST_DATABASE_URL=postgresql:///conscience_p2_test npm test -w @astratra/conscience
CONSCIENCE_TEST_DATABASE_URL=postgresql://localhost/conscience_p4_test node --test packages/conscience/test/shadow.postgres.test.js
```

PostgreSQL tests run only when the URL names a database ending in `_test`;
each test creates its own tables and drops them. A missing test database is
created with `createdb` when permitted; an unavailable database skips integration
tests with an explicit reason, without exposing the URL.

## Limits

- No language model and no automatic change: P2 evaluates structured evidence only, every change
  needs a human, and the governor never applies a change to your application by itself. It versions
  the objects and tells you which version to serve (`resolveVersion`); you read that version where
  you use the object.
- The governor recognises protected scopes by names and keys, not by reading
  text: a proposal must describe its target honestly, and anything ambiguous
  is rejected rather than allowed.
- The masker is yours: the package guarantees that stored text went through
  it, not that it found everything.
- Shadow mode only judges the sampled requests (a burst beyond `maxConcurrent` is skipped and counted) and its intervals ignore
  the pairing of requests: they are conservative. Metrics are yours and deterministic, and a tool read is only replayed from
  recordings.
