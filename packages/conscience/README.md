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
| `@astratra/conscience/governor` | P0 | Deterministic governor: constitution, permissions, budgets, isolation, kill switch, human approval, audit journal. Imports Node built-ins only: no language model, no AI package (a test walks its import graph). |
| `@astratra/conscience` | P1 | Decisions, predictions, outcomes with revisions, masked corrections, lessons with evidence, self-model, temporal memory, lineage, erasure, retention, memory guard. |
| `@astratra/conscience/autoconscience` | P2+ | Types of the reflective engine. `runReflection()` checks the governor, then refuses: it is not available before P2. |

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
proposer is refused. Approval records a decision; it does not apply the change
(versioned rollout and rollback come in P5).

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
  resume) is written to the audit journal before it is returned:
  `listAudit({ organisationId })`.

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
lessons and their history; deciding that a lesson is verified belongs to the
evaluator of P2.

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
postgresGovernorSchema({ prefix: 'astratra_governor' })     // <prefix>_proposals, _audit, _spend, _controls
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
`reserveSpend` (a transaction) and a compare-and-set `transitionProposal`
(`findOneAndUpdate` on `status`).

## Autoconscience (`/autoconscience`)

This version exports the types the reflective engine will use
(`ReflectionRun`, `ReflectionFinding`, `CalibrationPoint`, `Hypothesis`,
`Experiment`, `ErrorCostPolicy`, `CounterMetric`, `ToolReliability`,
`DomainCalendar`, `ShadowRun`, `Evaluator`) and `runReflection()`, which calls
`assertGovernorReady()` and then throws `not_available`.

Planned next, each behind the governor:

- P2, evaluation: calibration, honest statistics (minimum sample, intervals,
  the right not to conclude), cautious causality, contradictions, error costs,
  reasoning fidelity, tool reliability, business calendars, counter-metrics,
  cycle quality, classification of feedback.
- P3, experiments: time-frozen replay that refuses future data, sandbox,
  protected test set, drift monitoring, abstention, lessons turned into tests.
- P4, shadow mode in a sandbox. P5, versioned rollout, morning review,
  rollback. P6, guarded transfer between agents.

## Tests

```sh
npm test -w @astratra/conscience
CONSCIENCE_TEST_DATABASE_URL=postgresql://localhost/conscience_test npm test -w @astratra/conscience
```

PostgreSQL tests run only when the URL names a database ending in `_test`;
each test creates its own tables and drops them.

## Limits

- No language model, no evaluation and no automatic change in this version.
- The governor recognises protected scopes by names and keys, not by reading
  text: a proposal must describe its target honestly, and anything ambiguous
  is rejected rather than allowed.
- The masker is yours: the package guarantees that stored text went through
  it, not that it found everything.
