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
| `@astratra/conscience/autoconscience` | P2+ | Deterministic evaluation: calibration, statistics, conflicts, fidelity, tool reliability, calendars, error costs, counter-metrics and cycle utility. |

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

P3 experiments, P4 shadow mode and P6 guarded transfer remain outside
P2. Evaluation does not create a scheduler, a model transport or a deployment.

- P3, experiments: time-frozen replay that refuses future data, sandbox,
  protected test set, drift monitoring, abstention, lessons turned into tests.
- P4, shadow mode in a sandbox. P6, guarded transfer between agents.

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

## Tests

```sh
npm test -w @astratra/conscience
CONSCIENCE_TEST_DATABASE_URL=postgresql:///conscience_p2_test npm test -w @astratra/conscience
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
