/**
 * Per-person memories of an AI assistant.
 *
 * A memory belongs to one place, `{ ownerId, scope }` — a person, and the
 * partition the consumer chooses (a tenant, a workspace, '' for none). Every
 * read and every write carries that place to the store; nothing here can reach
 * another person's memories, except purgeOwner(), which erases one person
 * everywhere on purpose.
 *
 * Storage, embeddings, the model, the clock, ids, encryption and logs are all
 * injected. Without embeddings recall ranks by words and recency; without a
 * model there is no consolidation. Nothing else degrades.
 *
 * A correction never overwrites: it writes a new memory and marks the old one
 * superseded, so undo() puts the old one back. A forget erases the memory AND
 * the versions it replaced — an "erased" memory whose earlier wording is still
 * in the table is not erased.
 */
const { randomUUID } = require('crypto');
const {
  REASONS,
  wordsOf,
  cleanText,
  normalizeKind,
  normalizeImportance,
  checkCandidate
} = require('./rules');
const { cosine, keywordScore, fuseByRank, buildPortrait } = require('./ranking');
const { parseModelJson, defaultConsolidationPrompt, transcriptText } = require('./consolidation');

const DEFAULT_KINDS = Object.freeze(['goal', 'preference', 'fact', 'person', 'event', 'feeling']);
const CHANNELS = Object.freeze({ EXPLICIT: 'explicit', AUTO: 'auto', BACKGROUND: 'background' });
const REQUIRED_STORE = ['insert', 'get', 'list', 'update', 'remove', 'removeAll', 'purgeOwner', 'getSettings', 'setSettings'];
const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

class MemoryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'MemoryError';
    this.code = code;
  }
}

function assertStore(store) {
  if (!store || typeof store !== 'object') throw new MemoryError('invalid_store', 'createMemory requires options.store.');
  const missing = REQUIRED_STORE.filter((name) => typeof store[name] !== 'function');
  if (missing.length) throw new MemoryError('invalid_store', `options.store is missing: ${missing.join(', ')}.`);
}

/* A missing owner is a bug in the caller, never "everybody": it throws. */
function placeOf(where) {
  const ownerId = where && where.ownerId !== undefined && where.ownerId !== null ? String(where.ownerId) : '';
  if (!ownerId) throw new MemoryError('invalid_where', 'A memory operation needs where.ownerId.');
  const scope = where.scope === undefined || where.scope === null ? '' : String(where.scope);
  return { ownerId, scope };
}

function dateOf(value, code) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new MemoryError(code, `${code}: not a date.`);
  return date;
}

/* One queue per place in this process: two writes for one person never interleave. */
function createLocalLock() {
  const tails = new Map();
  return async function withLock(where, fn) {
    const key = `${where.ownerId}\u0000${where.scope}`;
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/**
 * @param {object} options see index.d.ts (MemoryOptions).
 */
function createMemory(options = {}) {
  const store = options.store;
  assertStore(store);

  const kinds = [...(options.kinds || DEFAULT_KINDS)];
  if (!kinds.length) throw new MemoryError('invalid_kinds', 'options.kinds must not be empty.');
  const kindAliases = options.kindAliases || {};
  const defaultKind = options.defaultKind ?? null;
  if (defaultKind !== null && !kinds.includes(defaultKind)) {
    throw new MemoryError('invalid_kinds', 'options.defaultKind must be one of options.kinds.');
  }
  const roleKinds = options.roleKinds || {};
  const rules = [...(options.rules || [])];
  const namesOf = options.namesOf || null;
  const embed = options.embed || null;
  const mask = options.mask || ((text) => text);
  const llm = options.llm || null;
  const cipher = options.cipher || null;
  const now = options.now || (() => new Date());
  const generateId = options.generateId || (() => randomUUID());
  const logger = { ...NOOP_LOGGER, ...(options.logger || {}) };
  const withLock = options.withLock || createLocalLock();
  const maxTextLength = options.maxTextLength ?? 500;
  const maxActive = options.maxActive === undefined ? 300 : options.maxActive;
  const duplicateThreshold = options.duplicateThreshold ?? 0.92;
  const minSimilarity = options.minSimilarity ?? null;
  const consolidationPrompt = options.consolidationPrompt || defaultConsolidationPrompt;
  const isExplicitFact = options.isExplicitFact || null;
  const knownForConsolidation = options.knownForConsolidation ?? 60;
  const knownTextMax = options.knownTextMax ?? 240;
  const transcriptMax = options.transcriptMax ?? 40000;

  const ruleConfig = { kinds, roleKinds, rules, maxTextLength };
  const kindOf = (value, fallback = defaultKind) => normalizeKind(value, { kinds, aliases: kindAliases, fallback });

  /* ---- text in and out of the store ----------------------------------- */

  async function seal(text) {
    if (!cipher) return text;
    const value = await cipher.encrypt(text);
    /* An encrypt that hands the text back has no key: refuse rather than store it in clear. */
    if (typeof value !== 'string' || value === text) throw new MemoryError('encryption_unavailable');
    return value;
  }

  async function open(record) {
    if (!record) return null;
    if (!cipher) return record;
    return { ...record, text: await cipher.decrypt(record.text) };
  }

  const openAll = (rows) => Promise.all((rows || []).map(open));

  /* What leaves the package: never the vector. */
  function publicMemory(record) {
    if (!record) return null;
    const out = {
      id: record.id,
      ownerId: record.ownerId,
      scope: record.scope,
      role: record.role ?? null,
      text: record.text,
      kind: record.kind,
      importance: record.importance,
      source: record.source || {},
      supersededBy: record.supersededBy || null,
      seenAt: record.seenAt || null,
      lastUsedAt: record.lastUsedAt || null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      hasVector: Array.isArray(record.vector) && record.vector.length > 0
    };
    if (typeof record.score === 'number') out.score = record.score;
    return out;
  }

  /* ---- embeddings ------------------------------------------------------ */

  async function vectorFor(text, purpose, where, extra = {}) {
    if (!embed) return null;
    try {
      const out = await embed(await mask(text, where), { purpose, ...extra });
      const vector = Array.isArray(out) ? out : out && out.vector;
      const source = (!Array.isArray(out) && out && out.source) || 'default';
      if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('The embedding function returned an invalid vector.');
      }
      return { vector, source: String(source) };
    } catch (error) {
      /* A failed embedding never loses the memory: it is kept without a vector, reindex() fills it later. */
      logger.warn(`[memory] embedding failed: ${error && error.message}`);
      return null;
    }
  }

  /* ---- the checks ------------------------------------------------------ */

  async function namesFor(where, ctx) {
    if (!namesOf) return [];
    try {
      return (await namesOf(where, ctx)) || [];
    } catch (error) {
      logger.warn(`[memory] namesOf failed: ${error && error.message}`);
      return [];
    }
  }

  async function refusalFor(where, candidate, ctx) {
    const names = await namesFor(where, ctx);
    return checkCandidate({ ...candidate, names }, ruleConfig);
  }

  /* ---- chains of versions ---------------------------------------------- */

  /* Every version the memory replaced, however deep. */
  async function ancestorsOf(where, id) {
    const found = [];
    const queue = [id];
    const seen = new Set([id]);
    while (queue.length) {
      const current = queue.shift();
      const older = await store.list(where, { state: 'superseded', supersededBy: current });
      for (const row of older) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        found.push(row.id);
        queue.push(row.id);
      }
    }
    return found;
  }

  async function removeWithHistory(where, ids) {
    const all = new Set();
    for (const id of ids) {
      all.add(id);
      for (const older of await ancestorsOf(where, id)) all.add(older);
    }
    return store.remove(where, [...all]);
  }

  /*
   * The cap: least important first, then the longest unused (never used
   * counts from its creation, not from the dawn of time).
   */
  async function enforceCap(where) {
    if (!maxActive) return 0;
    const active = await store.list(where, { state: 'active' });
    if (active.length <= maxActive) return 0;
    const last = (row) => new Date(row.lastUsedAt || row.createdAt || 0).getTime();
    const victims = active
      .sort((a, b) => a.importance - b.importance || last(a) - last(b))
      .slice(0, active.length - maxActive)
      .map((row) => row.id);
    await removeWithHistory(where, victims);
    return victims.length;
  }

  /* ---- writing --------------------------------------------------------- */

  /**
   * Keep one memory. Returns { ok: true, memory, supersededId } or
   * { ok: false, reason }. A near duplicate (same meaning, or the same words)
   * is replaced by the new one — undo() brings it back.
   */
  async function remember(whereInput, input = {}) {
    return keep(placeOf(whereInput), input, true);
  }

  async function keep(where, input, checkPause) {
    if (checkPause && (await isPaused(where))) return { ok: false, reason: REASONS.PAUSED };
    const candidate = {
      text: cleanText(input.text),
      kind: kindOf(input.kind),
      importance: normalizeImportance(input.importance),
      role: input.role ?? null,
      explicit: Boolean(input.explicit),
      personName: input.personName || ''
    };
    const reason = await refusalFor(where, candidate, input.ctx);
    if (reason) return { ok: false, reason };

    const embedding = await vectorFor(candidate.text, 'passage', where);
    const channel = input.channel || (candidate.explicit ? CHANNELS.EXPLICIT : CHANNELS.AUTO);

    return withLock(where, async () => {
      const active = await openAll(await store.list(where, { state: 'active' }));
      const words = wordsOf(candidate.text);
      const duplicate = (embedding
        && active.find((row) => Array.isArray(row.vector) && row.vectorSource === embedding.source
          && cosine(embedding.vector, row.vector) >= duplicateThreshold))
        || active.find((row) => wordsOf(row.text) === words)
        || null;

      const at = now();
      const record = {
        id: String(generateId()),
        ownerId: where.ownerId,
        scope: where.scope,
        role: candidate.role,
        text: await seal(candidate.text),
        kind: candidate.kind,
        importance: candidate.importance,
        source: { ...(input.source || {}), channel },
        vector: embedding ? embedding.vector : null,
        vectorSource: embedding ? embedding.source : null,
        supersededBy: null,
        seenAt: null,
        lastUsedAt: null,
        createdAt: at,
        updatedAt: at
      };
      const inserted = await open(await store.insert(record));
      if (duplicate) {
        await store.update(where, duplicate.id, { supersededBy: record.id, updatedAt: at }, { onlyActive: true });
      }
      await enforceCap(where);
      return { ok: true, memory: publicMemory(inserted), supersededId: duplicate ? duplicate.id : null };
    });
  }

  /**
   * Change one memory's text, kind or importance. The old version is kept
   * behind the new one, so undo(newId) restores it. A name the memory already
   * carried stays allowed; only a name the edit ADDS is refused.
   */
  async function update(whereInput, id, changes = {}, opts = {}) {
    const where = placeOf(whereInput);
    const old = await open(await store.get(where, String(id)));
    if (!old || old.supersededBy) return { ok: false, reason: REASONS.NOT_FOUND };

    const text = changes.text !== undefined ? cleanText(changes.text) : old.text;
    const kind = changes.kind !== undefined && changes.kind !== null ? kindOf(changes.kind, old.kind) : old.kind;
    const importance = changes.importance !== undefined && changes.importance !== null
      ? normalizeImportance(changes.importance, old.importance)
      : old.importance;
    const reason = await refusalFor(where, {
      text,
      kind,
      importance,
      role: old.role,
      explicit: Boolean(opts.explicit),
      personName: opts.personName || '',
      alreadyPresent: old.text
    }, opts.ctx);
    if (reason) return { ok: false, reason };
    if (text === old.text && kind === old.kind && importance === old.importance) {
      return { ok: true, memory: publicMemory(old), supersededId: null, unchanged: true };
    }

    /* New words carry a new meaning: the old vector would lie. */
    const embedding = text === old.text
      ? (Array.isArray(old.vector) ? { vector: old.vector, source: old.vectorSource } : null)
      : await vectorFor(text, 'passage', where);

    return withLock(where, async () => {
      const at = now();
      const record = {
        id: String(generateId()),
        ownerId: where.ownerId,
        scope: where.scope,
        role: old.role ?? null,
        text: await seal(text),
        kind,
        importance,
        source: { ...(old.source || {}), ...(opts.source || {}) },
        vector: embedding ? embedding.vector : null,
        vectorSource: embedding ? embedding.source : null,
        supersededBy: null,
        seenAt: old.seenAt || null,
        lastUsedAt: old.lastUsedAt || null,
        createdAt: at,
        updatedAt: at
      };
      const inserted = await open(await store.insert(record));
      const replaced = await store.update(where, old.id, { supersededBy: record.id, updatedAt: at }, { onlyActive: true });
      if (!replaced) {
        /* Changed meanwhile by someone else: take ours back, report the conflict. */
        await store.remove(where, [record.id]);
        return { ok: false, reason: REASONS.CONFLICT };
      }
      return { ok: true, memory: publicMemory(inserted), supersededId: old.id };
    });
  }

  /** Take back a memory just written; what it replaced comes back. */
  async function undo(whereInput, id) {
    const where = placeOf(whereInput);
    return withLock(where, async () => {
      const current = await store.get(where, String(id));
      if (!current || current.supersededBy) return false;
      const older = await store.list(where, { state: 'superseded', supersededBy: current.id });
      const removed = await store.remove(where, [current.id]);
      if (!removed) return false;
      const at = now();
      for (const row of older) await store.update(where, row.id, { supersededBy: null, updatedAt: at });
      return true;
    });
  }

  /** Erase one memory and every earlier version of it. */
  async function forget(whereInput, id) {
    const where = placeOf(whereInput);
    return withLock(where, async () => {
      const current = await store.get(where, String(id));
      if (!current) return false;
      return (await removeWithHistory(where, [current.id])) > 0;
    });
  }

  async function eraseAll(whereInput) {
    const where = placeOf(whereInput);
    return withLock(where, () => store.removeAll(where));
  }

  /** Right to erasure: this owner's memories, settings and consolidation marks, in every scope. */
  async function purgeOwner(ownerId) {
    const id = ownerId === undefined || ownerId === null ? '' : String(ownerId);
    if (!id) throw new MemoryError('invalid_where', 'purgeOwner needs an owner id.');
    return store.purgeOwner(id);
  }

  /* ---- reading --------------------------------------------------------- */

  async function get(whereInput, id) {
    const where = placeOf(whereInput);
    const record = await open(await store.get(where, String(id)));
    return record && !record.supersededBy ? publicMemory(record) : null;
  }

  /** Every current memory, newest first. No hidden cap: a person sees all of it. */
  async function list(whereInput, filter = {}) {
    const where = placeOf(whereInput);
    const kindsFilter = Array.isArray(filter.kinds) ? filter.kinds.map((kind) => kindOf(kind, null)).filter(Boolean) : undefined;
    const rows = await store.list(where, { state: 'active', kinds: kindsFilter, limit: filter.limit });
    return (await openAll(rows)).map(publicMemory);
  }

  /** Memories learnt in the background and not yet shown to the person. */
  async function listUnseen(whereInput) {
    const where = placeOf(whereInput);
    const rows = await store.list(where, { state: 'active', channel: CHANNELS.BACKGROUND, seen: false });
    return (await openAll(rows)).map(publicMemory);
  }

  async function markSeen(whereInput, ids = []) {
    const where = placeOf(whereInput);
    const at = now();
    let count = 0;
    for (const id of [...new Set((ids || []).map(String))]) {
      if (await store.update(where, id, { seenAt: at }, { onlyActive: true })) count += 1;
    }
    return count;
  }

  async function isPaused(whereInput) {
    const where = placeOf(whereInput);
    const settings = await store.getSettings(where);
    return Boolean(settings && settings.paused);
  }

  async function setPaused(whereInput, paused) {
    const where = placeOf(whereInput);
    const settings = await store.setSettings(where, { paused: Boolean(paused) });
    return Boolean(settings && settings.paused);
  }

  /**
   * Search by meaning and by words, fused by rank. Without embeddings (or
   * when they fail), by words, then the most recently useful. Found memories
   * are marked used — the portrait and the cap both read that.
   */
  async function recall(whereInput, input = {}) {
    const where = placeOf(whereInput);
    const text = cleanText(typeof input === 'string' ? input : input.query);
    if (!text) return [];
    const limit = Math.max(1, Math.min(Number.isInteger(input.limit) ? input.limit : 8, 20));
    const kindsFilter = Array.isArray(input.kinds) ? [...new Set(input.kinds.map((kind) => kindOf(kind, null)).filter(Boolean))] : undefined;
    if (kindsFilter && !kindsFilter.length) return [];
    const createdAfter = dateOf(input.after, 'invalid_after');
    const createdBefore = dateOf(input.before, 'invalid_before');
    const query = await vectorFor(text, 'query', where);

    let semantic;
    let lexical;
    /* Encrypted text cannot be matched by the database: the ranking happens here. */
    if (typeof store.search === 'function' && !cipher) {
      const found = await store.search(where, {
        text,
        vector: query ? query.vector : null,
        vectorSource: query ? query.source : null,
        kinds: kindsFilter,
        createdAfter,
        createdBefore,
        limit: limit * 4
      });
      semantic = (found.semantic || []).filter((row) => minSimilarity === null || typeof row.score !== 'number' || row.score >= minSimilarity);
      lexical = found.lexical || [];
    } else {
      const rows = await openAll(await store.list(where, { state: 'active', kinds: kindsFilter, createdAfter, createdBefore }));
      const last = (row) => new Date(row.lastUsedAt || row.createdAt || 0).getTime();
      lexical = rows.map((row) => ({ ...row, score: keywordScore(text, row.text) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || last(b) - last(a));
      semantic = query
        ? rows.filter((row) => Array.isArray(row.vector) && row.vectorSource === query.source)
          .map((row) => ({ ...row, score: cosine(query.vector, row.vector) }))
          .filter((row) => minSimilarity === null || row.score >= minSimilarity)
          .sort((a, b) => b.score - a.score)
        : [];
    }

    const byId = new Map();
    for (const row of [...lexical, ...semantic]) byId.set(row.id, row);
    const ids = fuseByRank([semantic.map((row) => row.id), lexical.map((row) => row.id)]).slice(0, limit);
    const at = now();
    const out = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue;
      await store.update(where, id, { lastUsedAt: at }, { onlyActive: true });
      out.push(publicMemory({ ...row, lastUsedAt: at }));
    }
    return out;
  }

  /** The short text always given to the model. `masked: true` passes it through `mask` first. */
  async function portrait(whereInput, opts = {}) {
    const where = placeOf(whereInput);
    const rows = await openAll(await store.list(where, { state: 'active' }));
    const text = buildPortrait(rows, opts);
    return opts.masked && text ? mask(text, where) : text;
  }

  /* ---- background ------------------------------------------------------ */

  /**
   * After a conversation: durable facts added, outdated memories corrected,
   * the episode summary returned. Never throws — it is background work.
   *
   * With `ref` (a conversation id) and a store that implements claimRef, a
   * conversation is consolidated once. Paused: the conversation is marked
   * done and nothing is learnt from it, even after the pause ends.
   */
  async function consolidate(whereInput, input = {}) {
    const empty = { added: 0, corrected: 0, refused: 0, summary: null };
    let where;
    try {
      where = placeOf(whereInput);
    } catch (error) {
      logger.warn(`[memory] consolidate: ${error.message}`);
      return { status: 'failed', ...empty };
    }
    if (!llm) return { status: 'unavailable', ...empty };
    const ref = input.ref === undefined || input.ref === null ? null : String(input.ref);
    const canClaim = ref && typeof store.claimRef === 'function';
    let claimed = false;
    try {
      if (canClaim) {
        claimed = await store.claimRef(where, ref);
        if (!claimed) return { status: 'already', ...empty };
      }
      if (await isPaused(where)) return { status: 'paused', ...empty };

      const raw = transcriptText(input.transcript).slice(0, transcriptMax);
      if (!raw.trim()) return { status: 'empty', ...empty };

      const last = (row) => new Date(row.lastUsedAt || 0).getTime();
      const knownRows = (await openAll(await store.list(where, { state: 'active' })))
        .sort((a, b) => b.importance - a.importance || last(b) - last(a)
          || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, knownForConsolidation);
      const known = new Map(knownRows.map((row) => [row.id, row]));
      const shown = [];
      for (const row of knownRows) shown.push({ id: row.id, text: String(await mask(row.text, where)).slice(0, knownTextMax) });

      const request = consolidationPrompt({
        kinds,
        known: shown,
        transcript: await mask(raw, where),
        language: input.language,
        role: input.role
      });
      const answer = await llm({ ...request, purpose: 'memory-consolidation', where });
      const parsed = parseModelJson(typeof answer === 'string' ? answer : JSON.stringify(answer));

      const result = { added: 0, corrected: 0, refused: 0, summary: null };
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) result.summary = parsed.summary.replace(/\s+/g, ' ').trim();
      const source = { ...(input.source || {}), ...(ref ? { ref } : {}) };
      const explicitFor = async (fact) => (isExplicitFact ? Boolean(await isExplicitFact(fact, input.transcript, where)) : false);

      /* A correction may only name a memory that was shown. */
      for (const correction of Array.isArray(parsed.corrections) ? parsed.corrections : []) {
        if (!correction || !known.has(String(correction.id))) continue;
        const outcome = await update(where, String(correction.id), {
          text: correction.text,
          kind: correction.kind,
          importance: correction.importance
        }, {
          personName: input.personName,
          explicit: await explicitFor(correction),
          source: { ...source, channel: CHANNELS.BACKGROUND },
          ctx: input.ctx
        });
        if (outcome.ok && !outcome.unchanged) result.corrected += 1;
        else if (!outcome.ok) result.refused += 1;
      }

      for (const fact of Array.isArray(parsed.facts) ? parsed.facts : []) {
        if (!fact || typeof fact.text !== 'string') continue;
        /* The pause was read once, before the model was asked. */
        const outcome = await keep(where, {
          text: fact.text,
          kind: fact.kind,
          importance: fact.importance,
          role: input.role,
          personName: input.personName,
          explicit: await explicitFor(fact),
          channel: CHANNELS.BACKGROUND,
          source,
          ctx: input.ctx
        }, false);
        if (outcome.ok) result.added += 1;
        else result.refused += 1;
      }
      logger.info(`[memory] consolidated: ${result.added} added, ${result.corrected} corrected, ${result.refused} refused`);
      return { status: 'done', ...result };
    } catch (error) {
      /* A failed run is retried next time: the conversation is not marked done. */
      if (claimed && typeof store.releaseRef === 'function') {
        try { await store.releaseRef(where, ref); } catch (_error) { /* the claim stays; nothing else to do */ }
      }
      logger.warn(`[memory] consolidation failed: ${error && error.message}`);
      return { status: 'failed', ...empty };
    }
  }

  /**
   * Give a vector to memories that have none — or, with `source`, one from
   * another embedding model, so the store converges on a single space. Stops
   * at the first failure: an embedding service that is down would fail them all.
   */
  async function reindex(opts = {}) {
    if (!embed || typeof store.listNeedingVector !== 'function') return { updated: 0, failed: 0 };
    const rows = await store.listNeedingVector({ limit: opts.limit ?? 50, source: opts.source });
    let updated = 0;
    for (const raw of rows) {
      const row = await open(raw);
      const where = { ownerId: row.ownerId, scope: row.scope };
      const embedding = await vectorFor(row.text, 'passage', where, opts.source ? { source: opts.source } : {});
      if (!embedding || (opts.source && embedding.source !== opts.source)) return { updated, failed: 1 };
      const done = await store.update(where, row.id, { vector: embedding.vector, vectorSource: embedding.source, updatedAt: now() }, { onlyActive: true });
      if (done) updated += 1;
    }
    return { updated, failed: 0 };
  }

  return {
    remember,
    recall,
    update,
    undo,
    forget,
    eraseAll,
    purgeOwner,
    get,
    list,
    listUnseen,
    markSeen,
    isPaused,
    setPaused,
    portrait,
    consolidate,
    reindex,
    kinds: Object.freeze([...kinds]),
    normalizeKind: (value, fallback) => kindOf(value, fallback === undefined ? defaultKind : fallback)
  };
}

module.exports = {
  createMemory,
  MemoryError,
  DEFAULT_KINDS,
  CHANNELS
};
