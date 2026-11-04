# @astratra/gouvernance

[English](README.md) | [Français](README.fr.md)

Governed data actions for AI agents. The agent never changes a database: it **proposes** an
action; the package computes the **exact preview** (rows and values touched), applies the
**autonomy levels**, verifies the **signed human validation**, **re-checks** the data at write time
and **runs all or nothing**, with a full **audit trail**. Node ≥ 20, CommonJS, MIT.

Built on [`@astratra/conscience`](../conscience/README.md): its governor provides the kill switch,
the audit journal and the calendar budgets (quotas). No language model is consulted: the same
proposal and the same rules always give the same decision.

```sh
npm install @astratra/gouvernance @astratra/conscience
```

| Entry | Content |
|---|---|
| `@astratra/gouvernance` | Contract, autonomy levels, lifecycle, signed validations, in-memory store and connector |
| `@astratra/gouvernance/postgres` | PostgreSQL connector and proposal store (a `pg` `Pool`; the package opens no connection) |
| `@astratra/gouvernance/mongo` | MongoDB connector and proposal store (the official driver's `Db` and `MongoClient`, never imported) |

## Lifecycle

1. **Propose**: a closed action object, never SQL nor a free-form query.
2. **Preview**: the rows that match now; for each, its key, the before and after values of the
   touched columns, and a version fingerprint.
3. **Level**: rules say whether the action is free, free with notice, needs validation, or is forbidden.
4. **Validation**: a person approves with a passkey (Face ID, Touch ID…); the validation service signs.
   The application checks both proofs.
5. **Re-check**: at write time rows are locked and read again; a row changed, deleted or appeared
   since the preview stops everything (`stale_data`).
6. **Execute**: all or nothing, in one transaction; the values written are exactly the preview's.
7. **Audit**: every step is written to the governor journal **before** acting; an unwritable journal
   prevents acting. The journal keeps codes and numbers, never values.
8. **Undo**: an executed action (except a delete) is undone by a human, within a window, if its rows
   have not changed since.

## Quick start

```js
const { createGovernor, createPostgresGovernorStore, postgresGovernorSchema } = require('@astratra/conscience/governor');
const { createDataGovernance } = require('@astratra/gouvernance');
const { createPostgresConnector, createPostgresGovernanceStore, postgresGovernanceSchema } = require('@astratra/gouvernance/postgres');

await pool.query(postgresGovernorSchema());
await pool.query(postgresGovernanceSchema());           // in the SAME database as the data
const governorStore = createPostgresGovernorStore(pool);
const governor = createGovernor({ budgets: { perCycle: 1, perAgent: 10, perOrganisation: 50 } }, { store: governorStore });

const governance = createDataGovernance({
  governor, auditStore: governorStore, store: createPostgresGovernanceStore(pool),
  connectors: { shop: createPostgresConnector({ pool, resources: {
    products: { table: 'shop.products', key: 'id', writable: ['price', 'stock'], filterable: ['promo', 'category'], tags: ['catalogue'], amount: 'price' }
  } }) },
  rules: [{ id: 'prices', level: 'validation', match: { resources: ['products'], amountAbove: 0 } }],
  trust: {
    keys: [{ keyId: 'key-2026-11', publicKey: process.env.VALIDATION_PUBLIC_KEY }],   // Ed25519 SPKI, base64
    approvers: [{ id: 'owner-1', credentials: [{ id: 'credential-id', publicKey: 'MFkw…' }] }],
    rpId: 'validation.example.com', origins: ['https://validation.example.com']
  }
});

const view = await governance.propose({
  organisationId: 'org-1', agent: { id: 'assistant', model: 'model-2026-10' },
  requestedBy: { kind: 'human', id: 'user-7' }, intent: { code: 'raise_prices', confidence: 0.86 },
  actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { promo: false }, set: { price: { multiply: 1.05, round: 2 } } }]
});
// view.status === 'awaiting_validation'; send view.proposal to the validation service.
const done = await governance.applyValidation(validation, { organisationId: 'org-1' });
```

## Resources, actions, levels

- **Resources** declare `table`, `key` (never writable nor sensitive), `writable`, `filterable`,
  `sensitive` (masked as `{ "$masked": "…" }`, salted HMAC, salt kept by the app), `tags`,
  `amount`, `maxRows` (100; above: `too_many_rows`), `operations` (`['update']`).
- **Actions**: `update` (`where` + `set`: value, `{ increment }`, `{ multiply, round? }`), `insert`
  (`values`, key required), `delete` (`where`). `where` is mandatory: plain value, `eq`, `ne`, `gt`,
  `gte`, `lt`, `lte`, `in` (≤ 500), `isNull`. At most 20 actions, one connector, no two actions on
  the same row.
- **Levels**: `free`, `free_with_notice` (undoable; deletes go to `validation`), `validation`,
  `forbidden`. Criteria: `ops`, `resources`, `tags`, `agents`, `rowsAbove`, `amountAbove`, `when`
  (`timeZone`, ISO `days`, `from`/`to`, overnight ranges allowed). The strictest matching rule wins;
  an uncovered write needs validation. Criteria are evaluated per resource with actions summed, so
  splitting a change does not get under a threshold. `approvals` (1–5), `quota.perDay`, global
  `quotas: { perDay, timeZone, store }`.
- **Remote rules** are added to local rules, so they can only tighten. Unreachable source: last
  known rules; never read: every write needs validation (`remote_rules_unavailable`). Rules are
  read again at execution time.

## Signed validation

Two proofs: the person's passkey, whose WebAuthn challenge is
`challengeFor({ propositionId, digest, decision, environment, approver, nonce })` (user presence and
verification required, checked against the app's own list of approver public keys), and the
validation service's Ed25519 signature over the whole validation (`signValidation`). The app only
holds public keys. Checks and refusal codes, in order: `bad_signature`, `unknown_key`,
`wrong_proposal`, `proposal_modified`, `wrong_environment`, `expired` (`maxAgeMs` 30 min, `skewMs`
30 s), `not_an_approver`, `bad_human_proof`, `duplicate_approver`, `self_approval`,
`not_enough_approvals`; a validation is used once (`replayed`). Decisions: `approve`, `decline`,
`undo`. A credential may carry its own `rpId` and `origins` (validation inside the app itself).
Keys rotate with `notAfter`.

The proposal sent out (`view.proposal`) carries its `digest` (SHA-256 of everything else), computed
on the masked form so the service can recompute it; `explanation` (the agent's text) is outside the
digest.

## PostgreSQL

`REPEATABLE READ` by default (or `serializable`): `SELECT … FOR UPDATE` with the original filter,
version comparison, writes by key (one row each), the proposal state in **the same transaction**,
then `COMMIT`. Concurrent writes (`40001`, `40P01`, `23505`) give `stale_data`; any other error
rolls everything back and gives `failed`. With the PostgreSQL store in the same database, a crash
never leaves data written without the `executed` state, nor the reverse.

## Measured trust

Rules loosen with evidence, **never by themselves**: the package only suggests, a person decides by changing the
rule. `governance.trustReport({ organisationId })` or `trustSuggestions(entries, options)` gives, per action type
(agent, resource, operations), outcome counts (`approved`, `declined`, `undone`, `unreviewed`, `unknown`), success
rate, Wilson interval, calibration (from `@astratra/conscience` autoconscience) and at most one suggestion: loosen
`validation` → `free_with_notice` (≥ 30 decisions, interval low bound ≥ 0.9, no undo) or tighten `free` /
`free_with_notice` → `validation` (≥ 3 undos, error rate ≥ 10 %). Never to `free` directly, never from or to
`forbidden`; below the sample threshold, no conclusion. Each suggestion carries a ready-to-review rule.

## MongoDB

`createMongoConnector({ db, client, ObjectId, resources, transactions = true })`, `createMongoGovernanceStore(db)`,
`mongoGovernanceIndexes(db)` (with mongoose: `connection.db`, `connection.getClient()`). Declare `types:
{ _id: 'objectId', soldAt: 'date' }` so the preview is JSON (hex, ISO) and writes restore the right type. All or
nothing through `withTransaction` (snapshot reads, majority writes), the proposal state in the same transaction;
transient errors replay everything, comparison included; write conflicts and duplicate keys give `stale_data`; any
other error rolls back and gives `failed`. A replica set (or cluster) is required: without it `check()` is `false`
and execution writes nothing. `transactions: false` allows a standalone server with **one write per proposal**
(`transactions_required` otherwise), filtered on the whole row read at preview time. Top-level fields only. The
store keeps records as JSON, so `$masked` values never become document keys.

## Commands

For an action that is not just rows in a database (sending an e-mail, starting a job):

```js
const { createCommandConnector } = require('@astratra/gouvernance');

const messages = createCommandConnector({ commands: {
  send_message: {
    fields: ['to', 'subject', 'body'], sensitive: ['to'], tags: ['outbound'],
    recheck: async ({ to }) => (await isBlocked(to) ? 'recipient_blocked' : null),   // at execution time
    run: async (values, { idempotencyKey }) => { await send(values, idempotencyKey); return { count: 1 }; }
  }
} });
// connectors: { messages }
await governance.propose({ ...input, actions: [{ connector: 'messages', resource: 'send_message', op: 'insert',
  values: { id: crypto.randomUUID(), to: 'parent@example.com', subject: 'Meeting', body: 'Monday at 9' } }] });
```

A command is proposed as an insert: its (scalar) values are the validated preview and `id` is its key. Nothing happens
before execution. One command per proposal, never undone, and `free_with_notice` becomes `validation`. If `run` throws,
the proposal becomes `failed` and is never retried. A command is not in a transaction: if `run` succeeds and saving the
result then fails, the proposal stays `failed` although the effect happened; use `idempotencyKey` to avoid duplicates
at the destination.

## Tests

```sh
GOUVERNANCE_TEST_DATABASE_URL=postgresql://localhost/gouvernance_test npm test
MONGO_TEST_URL=mongodb://localhost:27017/?replicaSet=rs0 npm test   # otherwise an in-memory replica set
```

## Limits

Agent reads do not go through this package; one database per proposal; deletes cannot be undone;
an action that makes a row enter the filter of a later action of the same proposal stops the
execution (`stale_data`); a row inserted by someone else during the transaction itself is not seen in
`REPEATABLE READ` nor in a MongoDB transaction (`isolation: 'serializable'` covers it for PostgreSQL).
