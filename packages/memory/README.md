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
- Beyond `maxActive` (300) active memories, the least important go first, then
  the longest unused (a never-used memory counts from its creation).

## Recall

`recall(where, { query, kinds, after, before, limit })` fuses two rankings by
reciprocal rank: meaning (cosine, same source only, optional `minSimilarity`)
and words (share of the query's words found, accents folded). Without `embed` —
or while it fails — it ranks by words, then by the most recently useful.
Returned memories are marked used, which the portrait and the cap both read.

If your store implements `search()` (a vector index, full-text search), recall
uses it. With a `cipher`, it cannot: encrypted text is ranked in process.

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

// PRIVACY_OPERATIONS: list, listUnseen, markSeen, setPaused, undo, erase, eraseAll, purgeOwner
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
| `maxTextLength`, `maxActive`, `duplicateThreshold`, `minSimilarity` | 500, 300, 0.92, none |
| `transcriptMax`, `transcriptKeep` | 40000, `'start'` |

`reindex({ limit, source })` gives a vector to memories without one — or, with
`source`, re-embeds those from another model — and stops at the first failure.

## License

MIT
