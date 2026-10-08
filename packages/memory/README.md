# @astratra/memory

What an AI assistant remembers about each person it talks to — kept, found,
corrected, taken back and erased — with the storage, the embeddings, the model
and every word shown to a person supplied by you.

No runtime dependency. CommonJS, Node 20+.

```bash
npm install @astratra/memory
```

## The idea in one screen

```js
const { createMemory, createMemoryStore, patternRule } = require('@astratra/memory');

const memory = createMemory({
  store: createMemoryStore(),                // your adapter in production
  embed: async (text, { purpose }) => ({ vector: await myEmbed(text, purpose), source: 'e5-small' }),
  llm: async ({ system, prompt }) => myModel.complete({ system, prompt }),
  rules: [patternRule({ code: 'secret', patterns: [/password|\bpin\b/i] })],
  namesOf: async (where) => directory.namesInTenant(where.scope) // other people, never stored
});

const where = { ownerId: user.id, scope: tenant.id };

await memory.remember(where, { text: 'Prefers short answers', kind: 'preference', importance: 4, role: user.role });
// → { ok: true, memory, supersededId } or { ok: false, reason: 'secret' }

await memory.recall(where, { query: 'how do they like answers?' });
await memory.portrait(where);                // "- Prefers short answers", for the system prompt
await memory.consolidate(where, { transcript, ref: conversation.id, role: user.role });
```

## Places, not users

Every memory belongs to a **place**: `{ ownerId, scope }`. `scope` is whatever
partition you need — a tenant, a workspace, `'global'` for staff, `''` for
none. Every store call carries the place; a memory is never visible from
another owner or another scope. A missing `ownerId` throws a `MemoryError`
(`invalid_where`) instead of meaning "everyone".

The one deliberate exception is `purgeOwner(ownerId)`: the right to erasure
removes a person's memories, settings and consolidation marks in **every**
scope.

## What is refused, and how you say it

Refusals are **codes**, never sentences. Your catalog turns them into words in
the person's language.

| code | when |
| --- | --- |
| `empty` | nothing left after cleaning |
| `too_long` | over `maxTextLength` (500 by default) |
| `invalid_kind` | not one of `kinds`, nor an alias, and no `defaultKind` |
| `kind_not_allowed` | `roleKinds[role]` does not list this kind |
| `other_person` | the text names someone from `namesOf()` |
| `paused` | the person paused their memory |
| `not_found`, `conflict`, `ai_disabled` | update/forget/tool outcomes |
| *yours* | any code returned by one of your `rules` |

Content rules are yours — a health product, a school and a bank do not forbid
the same things. `patternRule()` builds one from regular expressions:

```js
patternRule({ code: 'sensitive', patterns: [/diagnos/i], exceptRoles: ['minor'], allowWhenExplicit: true });
patternRule({ code: 'off_topic', patterns: [/relationship/i], roles: ['minor'] });
```

Patterns are tested on the raw text and on its accent-folded, lower-case form.
`allowWhenExplicit` lets through what the person explicitly asked to be
remembered (`explicit: true`).

**Names.** `namesOf(where)` returns the names of other people. They are matched
as whole words, accents and case folded ("Paul" is not found in "Pauline"). The
person's own name (`personName`) is always allowed. On an **edit**, a name the
memory already carried stays allowed — it was accepted with it; only a name
the edit *adds* is refused.

**Kinds and importance from real models.** Models send `"GOAL"`, `"Objectif"`,
`"4"`, `4.6`. Kinds are folded and looked up in `kinds`, then in
`kindAliases` (`{ objectif: 'goal' }` — yours, in whatever languages you
serve). Importance is rounded and clamped to 1–5, defaulting to 3.

Text is cleaned: model Markdown (`**`, backticks, `__`, a leading heading) is
removed and whitespace collapsed. `C#` and `snake_case` survive.

## Duplicates, corrections, undo

- A new memory whose vector is at least `duplicateThreshold` (0.92) close to an
  active one **of the same embedding source and the same length**, or whose
  words are the same, replaces it. Two embedding models never compare vectors,
  and neither do two vectors of different lengths under one label.
- `update(where, id, { text, kind, importance })` never overwrites. It writes a
  new version and marks the old one superseded; kind and importance stay unless
  given; the rules are checked again with the memory's original role.
- `update(where, id, changes, { inPlace: true })` edits the memory where it
  stands — same id, same creation date, no earlier version, nothing to undo.
  It is for a person correcting their own memory on a screen that lists it by
  id: a new id after each edit would leave the screen showing the old one.
- `undo(where, id)` removes a version just written and brings back what it
  replaced. It serves both "don't remember that" after `remember` and "put it
  back" after `update`.
- `forget(where, id)` erases the memory **and every earlier version of it**. A
  forgotten memory whose previous wording is still in the table is not
  forgotten. An earlier version is never forgotten on its own (`false`): the
  memory that replaced it would stay.
- Beyond `maxActive` (**1000** by default; `0` or `null` for no cap) active
  memories per person, the least important go first, then the longest unused (a
  never-used memory counts from its creation). `trimAbove` (default: `maxActive`)
  sets when the clean-up starts: with `maxActive: 1000, trimAbove: 1100` nothing
  is removed until the 1101st memory, which brings the person back to 1000 in
  one go instead of removing one memory per write. Under the threshold the cap
  costs no extra query. `markUsed()` and `recall()` both protect a memory
  from it.
- **Saying it again.** By default a duplicate is replaced by a new memory (new
  id, the old one kept behind it, `undo()` brings it back). With
  `onDuplicate: 'reinforce'` (the option, or `onDuplicate` in one `remember()`
  call) the existing memory stays: **same id**, same text, kind and creation
  date, importance raised to the higher of the two, `updatedAt` refreshed, and a
  vector it lacked is filled in. The result is
  `{ ok: true, memory, supersededId: null, reinforced: true }`; there is nothing
  to undo (the tool says `undo: null` and `reinforced: true`; `undo()` on that id
  would erase the memory itself). Consolidation follows the same option.

## Recall

`recall(where, { query, kinds, after, before, limit })` fuses two rankings by
reciprocal rank: meaning (cosine, same source only, optional `minSimilarity`)
and words (share of the query's words found, accents folded). Without `embed` —
or while it fails — it ranks by words, then by the most recently useful.
Returned memories are marked used, which the portrait and the cap both read.

If your store implements `search()` (a vector index, full-text search), recall
uses it. With a `cipher`, it cannot: encrypted text is ranked in process.

## Used, paused

```js
await memory.markUsed(where, ids);   // → how many were marked
await memory.pause(where);           // → true;  nothing new is kept or learnt
await memory.resume(where);          // → false
await memory.isPaused(where);        // setPaused(where, boolean) does both
```

`markUsed(where, ids)` marks active memories as used without a search — for
the ones you hand to the model yourself (the portrait, the most important at the
start of a conversation). Unknown, replaced or other people's ids are skipped.
`createMemoryHandlers()` has `pause(where)` and `resume(where)` too, among the
privacy operations that work with the AI off. A paused person can still read,
take back and erase.

## Portrait

`portrait(where, { maxLength = 1200, minImportance = 4, format, masked, fill })` —
important memories, most recently useful first, cut on a whole memory. It stops
at the first memory that no longer fits; with `fill: true` that one is left out
and the shorter ones after it still get their place. With `masked: true` the
text goes through your `mask` before it reaches a model.

## Consolidation after a conversation

```js
const result = await memory.consolidate(where, {
  transcript,                 // string, or [{ role, text }]
  ref: conversation.id,       // consolidated once (store.claimRef)
  role: user.role,
  personName: user.name,
  language: user.language
});
// { status: 'done' | 'already' | 'paused' | 'empty' | 'unavailable' | 'failed', added, corrected, refused, summary }
```

The model is shown the known memories (with ids, masked, 60 at most) and the
masked transcript, and returns `{ facts, corrections, summary }`. Corrections
may only name a memory it was shown. Every fact goes through the same rules as
`remember`. `isExplicitFact(fact, transcript)` decides whether the person asked
for a fact to be kept (for `allowWhenExplicit` rules, or your own rule reading
`candidate.explicit`).

The answer is read as models really give it (`readExtraction`, also exported):
a code fence or a sentence around the JSON, raw line breaks in strings, a
trailing comma, a bare list of facts, facts as plain strings, `memories` or
`new_facts` for `facts`, `updates` for `corrections`, `fact`/`memory`/`content`
for `text`, `type`/`category` for `kind`, `priority` for `importance`, and an
answer stopped half way (each whole fact before the cut is kept).

It **never throws**, and each write stands on its own: a fact that is refused
or whose write fails never loses the others. A failed run releases the `ref`
so the next run retries (what was kept merges as a duplicate). It says why, for
your logs: `{ status: 'failed', reason, error, added, corrected, refused,
failed, proposed }` with `reason` one of `model` (the function threw),
`unreadable` (nothing to read in the answer), `store` (`failed` writes threw),
`invalid_where`, `error`. `error` is the cause itself — classify it yourself,
never log the person's words.

A paused person's conversation is marked done and nothing is learnt from it,
even after the pause ends. The request is English by default; pass
`consolidationPrompt` to write your own. A transcript over `transcriptMax`
keeps its start, or its end with `transcriptKeep: 'end'` (what is new, when you
consolidate after each answer). Facts land on the `background` channel:
`listUnseen()` returns them until `markSeen()`.

## Privacy with the AI switched off

A person must always be able to see, pause, take back and erase what the
assistant keeps about them — including when the AI is off for their tenant,
their plan, or an outage.

```js
const { createMemoryHandlers, PRIVACY_OPERATIONS } = require('@astratra/memory');

const handlers = createMemoryHandlers({ memory, isAiEnabled: (where) => ai.isOn(where.scope) });

// PRIVACY_OPERATIONS: list, listUnseen, markSeen, setPaused, pause, resume, undo, erase, eraseAll, purgeOwner
// They never call isAiEnabled. Only `update` (editing content) does → { ok: false, reason: 'ai_disabled' }.
app.get('/me/memories', auth, async (req, res) => res.json(await handlers.list(placeFrom(req.user))));
```

Handlers are plain functions: mount them on any framework. Take the place from
your authentication, never from the request body.

## Tools for `@astratra/ai`

```js
const { createToolRegistry } = require('@astratra/ai');
const { createMemoryTools } = require('@astratra/memory');

const registry = createToolRegistry();
createMemoryTools({
  memory,
  roles: ['member', 'admin'],
  whereOf: (ctx) => ({ ownerId: ctx.userId, scope: ctx.tenantId }),   // required
  personNameOf: (ctx) => ctx.userName,
  isExplicit: (params, ctx) => myExplicitRequestDetector(ctx.command),
  isAiEnabled: (ctx) => ai.isOn(ctx.tenantId),
  translate: (code, ctx) => t(ctx.language, `memory.${code}`)       // optional
}).forEach((tool) => registry.register(tool));
```

`remember`, `recall`, `update_memory`, `forget` (renamable with `names`,
instructions replaceable with `descriptions`). Results are
`{ ok, code, ... }` — `memory_saved`, `memories_found`, `memory_corrected`,
`memory_forgotten`, or `refused` with a `reason` — plus `message` when you pass
`translate` (keys: the code, or `refused.<reason>`). Writes carry an
`undo: { id }` token for `memory.undo()`. `forget` erases: gate it with
`runAgentLoop({ confirmTool })` or `createPendingActions`.

## The store contract

`createMemoryStore()` is the in-process reference. For a real database, write
an adapter with these methods (types in `index.d.ts`):

| method | |
| --- | --- |
| `insert(record)` | the service supplies `id` |
| `get(where, id)` | any state; `null` outside the place |
| `list(where, filter)` | `state` (`active` default, `superseded`, `all`), `supersededBy`, `kinds`, `channel`, `seen`, `createdAfter/Before`, `limit`, `withVector` (`false`: leave the vectors out, set `hasVector`); newest first |
| `update(where, id, patch, { onlyActive })` | never moves a record; `onlyActive` is a compare-and-set on "not superseded" |
| `remove(where, ids)`, `removeAll(where)` | counts |
| `purgeOwner(ownerId)` | every scope; `{ memories, settings, refs }` |
| `getSettings(where)`, `setSettings(where, patch)` | `{ paused }` |
| `claimRef`, `releaseRef` | optional — once-per-conversation consolidation (a host that follows its own watermark, "read up to this message", does without) |
| `search(where, input)` | optional — `{ semantic, lexical }` ranked records |
| `listNeedingVector({ limit, source })` | optional — for `reindex()` |

Prove it with the contract suite, in your adapter's tests:

```js
const { runStoreContract } = require('@astratra/memory');
runStoreContract(async () => createMyStore(await freshDatabase()));
```

The suite runs under Jest or Vitest as it is. Under `node:test`, hand it the
runner (its own small `expect` is used when there is none). A store whose ids
have a shape (a UUID column) gives it a generator, and must answer "not found",
never throw, for an id of another shape:

```js
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
runStoreContract(async () => createMyStore(await freshDatabase()), { describe, test, newId: randomUUID });
```

A store whose **scope is a foreign key** (an organisation table) cannot be given
invented scopes: pass `makeScope`, which creates the organisation and returns its
id. `makeOwner` does the same for owners. Both receive the name the suite uses
(`'scope-1'`, `'scope-2'`; `'owner-a'`, `'owner-b'`, `'owner-z'`) and the store
being tested, and must return the same value for the same name within one store.
A store with a fixed vector size passes `vectorDimensions`; the suite pads its
test vectors to it.

```js
runStoreContract(async () => createMyStore(await freshDatabase()), {
  newId: randomUUID,
  makeScope: async (name, store) => (await db.query('INSERT INTO organisations (id) VALUES (gen_random_uuid()) RETURNING id')).rows[0].id,
  makeOwner: (name) => ownerIds[name] ??= randomUUID()
});
```

## PostgreSQL store, ready to use

`createPostgresMemoryStore(db, options)` is a reference adapter that passes the
contract: parameterised queries (nothing a person writes is ever in the SQL
text), a place carried by every statement, full text search, and pgvector when
you supply the embeddings. `db` is anything with `query(sql, params)`: a `pg`
Pool, a client inside a transaction. The package does not depend on `pg`.

```js
const { createMemory, createPostgresMemoryStore, postgresMemorySchema } = require('@astratra/memory');

// once, in a migration of yours (idempotent):
await pool.query(postgresMemorySchema());

const memory = createMemory({ store: createPostgresMemoryStore(pool) });
```

The schema makes three tables: `memories` (one row per memory, `owner_id` the
person, `scope` the organisation or workspace), `memories_settings` (the pause)
and `memories_refs` (conversations already consolidated). Options, the same for
the schema and the store:

| option | default | |
| --- | --- | --- |
| `table`, `settingsTable`, `refsTable` | `memories`, `memories_settings`, `memories_refs` | plain identifiers, `ia.memories` accepted |
| `idType`, `ownerType`, `scopeType` | `text` | `'uuid'` for a uuid column: a place or id that is not a UUID then finds nothing, never throws |
| `scopeReferences` | none | schema only: `'organisations(id)'` makes the scope a foreign key, `ON DELETE CASCADE` |
| `vectors` | `'json'` | `'json'`: jsonb, cosine computed in process over the vectors of one source; `'pgvector'`: `vector(N)` column, HNSW cosine index, `ORDER BY <=>` |
| `vectorDimensions` | | size of your embeddings, required with `'pgvector'` (an embedding of another size is refused by PostgreSQL) |
| `textSearchConfig` | `'simple'` | `'french'`, `'english'`… |
| `search` | `true` | `false`: no full text column, no `search()`; the package ranks in process |

Recall by words uses a generated `tsvector` column with a GIN index (the words
of the query joined by "or", ranked by `ts_rank`), then a fragment match when no
word is found. With a `cipher` the text is not searchable by the database and
`createMemory` ranks in process, as for any store. `getSettings` keeps `paused`
only. For several processes, compose `withLock` with a lock of the database
(`pg_advisory_lock`).

Its tests run without a database (queries, schema, refusals). The contract and
the end-to-end scenarios run against a real PostgreSQL when you give them one:

```bash
MEMORY_TEST_DATABASE_URL=postgres:///my_test MEMORY_TEST_PGVECTOR=1 npm test -w @astratra/memory
```

(the name must end in `_test`; `MEMORY_TEST_PGVECTOR=1` also tests pgvector,
which must be installed).

## Everything injected

| option | default |
| --- | --- |
| `store` | required |
| `kinds` | `goal, preference, fact, person, event, feeling` |
| `kindAliases`, `defaultKind`, `roleKinds`, `rules`, `namesOf` | none |
| `embed(text, { purpose })` → `number[]` or `{ vector, source }` | none: word ranking |
| `mask(text, where)` | identity — applied before `embed` and the model |
| `llm({ system, prompt, purpose, where })` → string | none: no consolidation |
| `cipher { encrypt, decrypt }` | none — an `encrypt` that returns its input is refused |
| `now`, `generateId`, `logger` | `new Date()`, `randomUUID()`, silent |
| `withLock(where, fn)` | in-process queue per place (`createLocalLock()`, exported to compose with a lock shared across instances) |
| `maxTextLength`, `maxActive`, `duplicateThreshold`, `minSimilarity` | 500, 1000, 0.92, none |
| `trimAbove` | `maxActive` |
| `onDuplicate` | `'replace'` (or `'reinforce'`) |
| `transcriptMax`, `transcriptKeep` | 40000, `'start'` |

`reindex({ limit, source })` gives a vector to memories without one — or, with
`source`, re-embeds those from another model — and stops at the first failure.

## License

MIT
