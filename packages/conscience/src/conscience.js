'use strict';
const { ConscienceError } = require('./errors');
const { normalize, scopeOf, KINDS } = require('./records');
const { wordDelta } = require('./diff');
const { createMemoryConscienceStore } = require('./memoryStore');
const { assertGovernorReady, isGovernor } = require('./governor/governor');
const { fingerprintOf, copy, isNonEmptyString, GovernorError } = require('./governor/util');

const { oppositeLessons, assessedLessonStatus } = require('./autoconscience/lessons');
const { minimum } = require('./autoconscience/statistics');
const PAGE = 1000;
const ERASURE_MODES = Object.freeze(['delete', 'anonymise']);
const INTERNAL_EVIDENCE = Object.freeze(['decision', 'prediction', 'outcome', 'correction']);

function maskerOf(masker) {
  if (typeof masker === 'function') return masker;
  if (masker && typeof masker.redactString === 'function') return (text) => masker.redactString(text);
  if (masker && typeof masker.mask === 'function') return (text) => masker.mask(text);
  throw new ConscienceError('masker_required', 'A masker is required: a function (text) => masked text, a redactor of @astratra/privacy, or an object with mask(text).');
}

function retentionOf(retention = {}) {
  const erasure = retention.erasure ?? 'delete';
  if (!ERASURE_MODES.includes(erasure)) throw new ConscienceError('invalid_input', 'retention.erasure must be "delete" or "anonymise".');
  const maxAgeDays = { ...(retention.maxAgeDays ?? {}) };
  for (const [kind, days] of Object.entries(maxAgeDays)) {
    if (!KINDS.includes(kind)) throw new ConscienceError('invalid_input', `retention.maxAgeDays: unknown kind "${kind}".`);
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) throw new ConscienceError('invalid_input', `retention.maxAgeDays.${kind} must be a positive number of days.`);
  }
  return Object.freeze({ erasure, maxAgeDays: Object.freeze(maxAgeDays) });
}

/** Revision bookkeeping: number, current flag and when a later revision replaced it. */
function withRevisions(envelopes, groupOf) {
  const groups = new Map();
  for (const envelope of envelopes) {
    const key = groupOf(envelope);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(envelope);
  }
  const out = [];
  for (const list of groups.values()) {
    list.forEach((envelope, index) => {
      const next = list[index + 1];
      out.push({ ...envelope.data, revision: index + 1, current: !next, supersededAt: next ? next.recordedAt : null });
    });
  }
  return out;
}

/**
 * Conscience (P1): the documented memory of an agent's decisions. Records
 * decisions, predictions, outcomes, corrections, lessons and self-model
 * snapshots; isolates every read and write by organisation (and person);
 * keeps every revision; erases a person completely.
 */
function createConscience(options = {}) {
  if (options.governor == null) {
    throw new GovernorError('governor_missing', 'No governor: conscience refuses to start without one (createGovernor(policy) from @astratra/conscience/governor).');
  }
  if (!isGovernor(options.governor)) {
    throw new GovernorError('governor_invalid', 'governor must be built by createGovernor() from @astratra/conscience/governor.');
  }
  const governor = options.governor;
  const mask = maskerOf(options.masker);
  const store = options.store ?? createMemoryConscienceStore();
  for (const method of ['put', 'get', 'list', 'replace', 'remove']) {
    if (typeof store[method] !== 'function') throw new ConscienceError('store_invalid', `Conscience store is missing ${method}().`);
  }
  const now = options.now ?? Date.now;
  const retention = retentionOf(options.retention);
  const minimumSample = minimum(options.minimumSample);
  const erasers = options.erasers ?? [];
  if (!Array.isArray(erasers) || !erasers.every((fn) => typeof fn === 'function')) throw new ConscienceError('invalid_input', 'erasers must be an array of functions.');
  const iso = () => new Date(now()).toISOString();

  async function emit(event) {
    try { await options.onEvent?.({ type: 'conscience', ...event }); } catch (_error) { /* Observers never change a record. */ }
  }

  async function maskText(value) {
    if (value == null) return value;
    const masked = await mask(String(value));
    if (typeof masked !== 'string') throw new ConscienceError('masker_invalid', 'The masker must return a string.');
    return masked;
  }
  async function maskDeep(value, depth = 0) {
    if (typeof value === 'string') return maskText(value);
    if (depth > 32 || value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Promise.all(value.map((item) => maskDeep(item, depth + 1)));
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = await maskDeep(child, depth + 1);
    return out;
  }

  const organisationOf = (input) => governor.assertSingleOrganisation(scopeOf(input).organisationId);
  const visible = (envelope, scope) => Boolean(envelope) && envelope.organisationId === scope.organisationId
    && (scope.userId == null || envelope.userId === scope.userId);
  const readScope = (scope) => { const s = scopeOf(scope); governor.assertSingleOrganisation(s.organisationId); return s; };
  const idOf = (input, prefix, fingerprint) => {
    if (input.id == null) return `${prefix}_${fingerprint.slice(0, 32)}`;
    if (!isNonEmptyString(input.id) || input.id.length > 500) throw new ConscienceError('invalid_input', 'id must be a non-empty string of at most 500 characters.');
    return input.id;
  };

  async function put(envelope) {
    const { record, created } = await store.put(envelope);
    if (!created && record.fingerprint !== envelope.fingerprint) throw new ConscienceError('conflict', `A different ${envelope.kind} already uses the id "${envelope.id}". Records are immutable: record a revision instead.`);
    if (created) await emit({ action: 'recorded', kind: envelope.kind, id: envelope.id, organisationId: envelope.organisationId });
    return { record, created };
  }

  function envelopeOf(kind, data, fields) {
    return {
      kind, id: data.revisionId ?? data.id, organisationId: data.organisationId, userId: data.userId ?? null,
      agentId: fields.agentId ?? null, decisionId: fields.decisionId ?? null, lessonId: fields.lessonId ?? null,
      eventAt: fields.eventAt ?? null, recordedAt: data.recordedAt, fingerprint: fields.fingerprint,
      evidenceRefs: fields.evidenceRefs ?? [], data
    };
  }

  async function decisionIn(organisationId, decisionId) {
    const found = await store.get('decision', organisationId, decisionId);
    if (!found) throw new ConscienceError('not_found', 'Decision not found.');
    return found;
  }

  async function listAll(kind, filter) {
    return store.list(kind, { ...filter, limit: filter.limit ?? 10000 });
  }

  /* ---------- active mode: decisions, predictions, outcomes, corrections ---------- */

  async function recordDecision(input) {
    const n = normalize.decision(input);
    organisationOf(n);
    const fingerprint = fingerprintOf({ kind: 'decision', ...n });
    const id = idOf(input, 'dec', fingerprint);
    const data = {
      id, ...n,
      objective: await maskText(n.objective),
      context: { at: n.context.at, summary: await maskText(n.context.summary), data: await maskDeep(n.context.data) },
      action: { ...n.action, input: await maskDeep(n.action.input) },
      alternatives: await maskDeep(n.alternatives),
      expectedOutcome: await maskDeep(n.expectedOutcome),
      recordedAt: iso()
    };
    const { record, created } = await put(envelopeOf('decision', data, { agentId: n.agentId, decisionId: id, eventAt: n.decidedAt, fingerprint }));
    return { decision: record.data, created };
  }

  async function recordPrediction(input) {
    const n = normalize.prediction(input);
    organisationOf(n);
    const decision = await decisionIn(n.organisationId, n.decisionId);
    const fingerprint = fingerprintOf({ kind: 'prediction', ...n });
    const id = idOf(input, 'pred', fingerprint);
    const data = { id, ...n, domain: n.domain ?? decision.data.domain ?? 'general', userId: n.userId ?? decision.userId, agentId: decision.agentId, statement: await maskText(n.statement), recordedAt: iso() };
    data.madeAt = n.madeAt ?? data.recordedAt;
    const { record, created } = await put(envelopeOf('prediction', data, { agentId: decision.agentId, decisionId: n.decisionId, eventAt: data.madeAt, fingerprint }));
    return { prediction: record.data, created };
  }

  async function attachOutcome(input) {
    const n = normalize.outcome(input);
    organisationOf(n);
    const decision = await decisionIn(n.organisationId, n.decisionId);
    if (n.predictionId) {
      const prediction = await store.get('prediction', n.organisationId, n.predictionId);
      if (!prediction || prediction.decisionId !== n.decisionId) throw new ConscienceError('not_found', 'Prediction not found for this decision.');
    }
    const fingerprint = fingerprintOf({ kind: 'outcome', ...n });
    const id = idOf(input, 'out', fingerprint);
    const existing = await store.get('outcome', n.organisationId, id);
    const previous = existing ? null : (await store.list('outcome', { organisationId: n.organisationId, decisionId: n.decisionId, order: 'desc', limit: 10000 }))
      .find((envelope) => envelope.data.sensor === n.sensor) ?? null;
    const data = {
      id, ...n, userId: n.userId ?? decision.userId, agentId: decision.agentId,
      observation: await maskText(n.observation), confounders: await maskDeep(n.confounders),
      revises: previous ? previous.id : null, recordedAt: iso()
    };
    const { record, created } = await put(envelopeOf('outcome', data, { agentId: decision.agentId, decisionId: n.decisionId, eventAt: n.observedAt, fingerprint }));
    const versions = await getOutcomes({ organisationId: n.organisationId }, n.decisionId);
    const self = versions.find((version) => version.id === record.id);
    return { outcome: self ?? record.data, created };
  }

  async function recordCorrection(input) {
    const n = normalize.correction(input);
    organisationOf(n);
    const decision = await decisionIn(n.organisationId, n.decisionId);
    const fingerprint = fingerprintOf({ kind: 'correction', ...n });
    const id = idOf(input, 'cor', fingerprint);
    const delta = wordDelta(await maskText(n.proposed), await maskText(n.final));
    const data = {
      id, organisationId: n.organisationId, userId: n.userId ?? decision.userId, agentId: decision.agentId, decisionId: n.decisionId,
      class: n.class, authorRole: n.authorRole, correctedAt: n.correctedAt, delta, recordedAt: iso()
    };
    const { record, created } = await put(envelopeOf('correction', data, { agentId: decision.agentId, decisionId: n.decisionId, eventAt: n.correctedAt, fingerprint }));
    return { correction: record.data, created };
  }

  /* ---------- reflective writes: lessons and self-model (governor required) ---------- */

  async function appendRevision(kind, content, chain, prefix, fields) {
    const contentFingerprint = fingerprintOf({ kind, ...content.raw });
    const latest = (await store.list(kind, { organisationId: content.raw.organisationId, ...chain, order: 'desc', limit: 1 }))[0];
    if (latest && latest.data.contentFingerprint === contentFingerprint) return { record: latest, created: false };
    const fingerprint = fingerprintOf({ contentFingerprint, previous: latest ? latest.id : null });
    const data = { ...content.data, revisionId: `${prefix}#${fingerprint.slice(0, 20)}`, contentFingerprint, previousRevision: latest ? latest.id : null, recordedAt: iso() };
    await assertGovernorReady(governor, { organisationId: content.raw.organisationId });
    return put(envelopeOf(kind, data, { ...fields(data), fingerprint }));
  }

  async function lessonSample(n, { strict = true, asOf } = {}) {
    const decisions = new Set();
    let factualEligible = true;
    for (const item of n.evidence) {
      if (!INTERNAL_EVIDENCE.includes(item.kind)) continue;
      const found = await store.get(item.kind, n.organisationId, item.ref);
      if (!found || (asOf != null && found.recordedAt > new Date(asOf).toISOString()) || (n.userId != null && found.userId !== n.userId)) {
        if (strict) throw new ConscienceError('evidence_not_found', 'Evidence not found in this scope.');
        continue;
      }
      if (n.agentId != null && found.agentId !== n.agentId) continue;
      const decision = await store.get('decision', n.organisationId, found.decisionId);
      if (!decision || (decision.data.domain ?? 'general') !== n.domain) continue;
      if (item.kind === 'correction') {
        if (found.data.class !== 'factual') { if (n.factual) factualEligible = false; continue; }
        if (!found.data.delta?.unchanged) decisions.add(found.decisionId);
      }
      if (item.kind === 'outcome' && found.data.status !== 'unknown') {
        const current = (await getOutcomes({ organisationId: n.organisationId, asOf }, found.decisionId)).find((o) => o.id === found.id);
        if (current?.current) decisions.add(found.decisionId);
      }
    }
    return { sampleSize: decisions.size, factualEligible };
  }

  async function persistLesson(n, requested) {
    await assertGovernorReady(governor, { organisationId: n.organisationId });
    const sample = await lessonSample(n);
    n = { ...n, ...sample };
    if (n.status !== 'retired') n.status = assessedLessonStatus(n, { minimumSample: Math.max(minimumSample, n.minimumSample) });
    if (!n.evidence.length) n.evidenceDegree = 'none';
    const lessonId = n.lessonId;
    const raw = { ...n, lessonId };
    const data = { id: lessonId, ...n, summary: await maskText(n.summary),
      evidence: await Promise.all(n.evidence.map(async (item) => ({ ...item, note: await maskText(item.note) }))), statusForced: requested !== n.status };
    delete data.lessonId;
    const { record, created } = await appendRevision('lesson', { raw, data }, { lessonId }, lessonId, (d) => ({
      agentId: n.agentId, lessonId, eventAt: d.validFrom ?? d.recordedAt, evidenceRefs: n.evidence.map((item) => item.ref)
    }));
    return { lesson: record.data, created, statusForced: record.data.statusForced };
  }

  async function recordLesson(input) {
    const n = normalize.lesson({ minimumSample, ...input });
    const organisationId = organisationOf(n);
    await assertGovernorReady(governor, { organisationId });
    n.lessonId ??= `lesson_${fingerprintOf({ organisationId, userId: n.userId, agentId: n.agentId, summary: n.summary }).slice(0, 32)}`;
    const requested = n.status;
    const current = await listLessons({ organisationId, userId: n.userId ?? undefined });
    for (const ref of [...n.contradictions, ...n.supersedes]) {
      if (!current.some((l) => l.id === ref)) throw new ConscienceError('not_found', 'Referenced lesson not found in this scope.');
    }
    // Open conflicts are symmetric. Retired opponents stay in history but cannot block verification.
    const opposing = current.filter((l) => oppositeLessons({ ...n, id: n.lessonId }, l));
    n.contradictions = [...new Set([...n.contradictions.filter((id) => current.some((l) => l.id === id && l.status !== 'retired')), ...opposing.map((l) => l.id)])];
    const result = await persistLesson(n, requested);
    for (const other of opposing) {
      await persistLesson(normalize.lesson({ ...other, lessonId: other.id, status: 'to_reassess', contradictions: [...new Set([...other.contradictions, n.lessonId])] }), other.status);
    }
    return result;
  }

  /** Explicit evidence-based arbitration; preserves every earlier revision. */
  async function resolveLessonConflict(input) {
    const s = readScope(input);
    await assertGovernorReady(governor, s);
    const winner = (await getLesson(s, input.winnerId))?.current;
    const loser = (await getLesson(s, input.loserId))?.current;
    if (!winner || !loser) throw new ConscienceError('not_found', 'Conflict lessons not found.');
    if (!oppositeLessons(winner, loser)) throw new ConscienceError('invalid_input', 'No opposite lessons in this scope and domain.');
    const evidence = input.evidence ?? [];
    if (!evidence.length) throw new ConscienceError('invalid_input', 'Arbitration requires new evidence.');
    const candidate = normalize.lesson({ ...winner, lessonId: winner.id, evidence, contradictions: [] });
    const sample = await lessonSample(candidate);
    if (assessedLessonStatus({ ...candidate, ...sample }, { minimumSample: Math.max(minimumSample, candidate.minimumSample) }) !== 'verified') {
      throw new ConscienceError('insufficient_evidence', 'Arbitration requires sufficient factual evidence in the same domain.');
    }
    const retired = await recordLesson({ ...loser, lessonId: loser.id, status: 'retired' });
    const resolved = await recordLesson({ ...winner, lessonId: winner.id, evidence, status: 'verified', contradictions: winner.contradictions.filter((id) => id !== loser.id), supersedes: [...new Set([...winner.supersedes, loser.id])] });
    return { winner: resolved.lesson, loser: retired.lesson };
  }

  async function updateSelfModel(input) {
    const n = normalize.self_model(input);
    const organisationId = organisationOf(n);
    await assertGovernorReady(governor, { organisationId });
    const data = { id: `self_${n.agentId}`, ...n };
    const { record, created } = await appendRevision('self_model', { raw: n, data }, { agentId: n.agentId }, `self_${n.agentId}`, (d) => ({
      agentId: n.agentId, eventAt: d.at ?? d.recordedAt
    }));
    return { snapshot: { ...record.data, at: record.data.at ?? record.data.recordedAt }, created };
  }

  /* ---------- reads ---------- */

  async function getDecision(scope, id) {
    const s = readScope(scope);
    const found = await store.get('decision', s.organisationId, id);
    return visible(found, s) ? found.data : null;
  }

  async function getOutcomes(scope, decisionId) {
    const s = readScope(scope);
    if (!(await getDecision(s, decisionId))) return [];
    const list = await listAll('outcome', { organisationId: s.organisationId, decisionId, recordedTo: scope.asOf ? new Date(scope.asOf).toISOString() : undefined });
    return withRevisions(list.filter((envelope) => visible(envelope, s)), (envelope) => envelope.data.sensor);
  }

  async function recallDecisions(scope, query = {}) {
    const s = readScope(scope);
    const filter = { organisationId: s.organisationId, limit: Math.min(Math.max(Number(query.limit) || 100, 1), 1000), order: query.order === 'asc' ? 'asc' : 'desc' };
    if (s.userId != null) filter.userId = s.userId;
    if (query.agentId != null) filter.agentId = query.agentId;
    if (query.from != null) filter.eventFrom = new Date(query.from).toISOString();
    if (query.to != null) filter.eventTo = new Date(query.to).toISOString();
    if (query.asOf != null) filter.recordedTo = new Date(query.asOf).toISOString();
    const decisions = (await store.list('decision', filter)).filter((envelope) => visible(envelope, s)).map((envelope) => envelope.data);
    if (!query.withOutcomes) return decisions;
    return Promise.all(decisions.map(async (decision) => ({
      ...decision,
      outcomes: (await getOutcomes({ ...s, asOf: query.asOf }, decision.id)).filter((outcome) => outcome.current)
    })));
  }

  async function lessonsCurrent(s, filter = {}) {
    const query = { organisationId: s.organisationId };
    if (s.userId != null) query.userId = s.userId;
    if (filter.agentId != null) query.agentId = filter.agentId;
    if (filter.lessonId != null) query.lessonId = filter.lessonId;
    if (filter.evidenceRef != null) query.evidenceRef = filter.evidenceRef;
    if (filter.asOf != null) query.recordedTo = new Date(filter.asOf).toISOString();
    let envelopes = await listAll('lesson', query);
    if (filter.evidenceRef != null) {
      const ids = [...new Set(envelopes.map((envelope) => envelope.lessonId))];
      envelopes = [];
      for (const lessonId of ids) envelopes.push(...await listAll('lesson', { ...query, evidenceRef: undefined, lessonId }));
    }
    return withRevisions(envelopes.filter((envelope) => visible(envelope, s)), (envelope) => envelope.lessonId);
  }

  async function getLesson(scope, lessonId, { asOf } = {}) {
    const s = readScope(scope);
    const history = await lessonsCurrent(s, { lessonId, asOf });
    if (!history.length) return null;
    const current = (await assessedLessons(s, history.filter((l) => l.current), { asOf }))[0];
    return { current, history };
  }

  async function assessedLessons(scope, selected, { asOf } = {}) {
    const all = (await lessonsCurrent(scope, { asOf })).filter((l) => l.current);
    const assessed = [];
    for (const l of selected) {
      const sample = await lessonSample({ ...l, minimumSample: l.minimumSample ?? minimumSample }, { strict: false, asOf });
      const contradictions = [...new Set([...(l.contradictions ?? []).filter((id) => all.some((other) => other.id === id && other.status !== 'retired')),
        ...all.filter((other) => oppositeLessons(l, other)).map((other) => other.id)])];
      const status = l.status === 'retired' ? 'retired' : assessedLessonStatus({ ...l, ...sample, contradictions }, { minimumSample: Math.max(minimumSample, l.minimumSample ?? minimumSample) });
      assessed.push({ ...l, ...sample, contradictions, storedStatus: l.status, status });
    }
    return assessed;
  }

  async function listLessons(scope, filter = {}) {
    const s = readScope(scope);
    const at = filter.validAt != null ? new Date(filter.validAt).toISOString() : null;
    const current = (await lessonsCurrent(s, filter)).filter((l) => l.current);
    return (await assessedLessons(s, current, { asOf: filter.asOf })).filter((lesson) => (filter.status == null || lesson.status === filter.status)
      && (at == null || ((lesson.validFrom == null || lesson.validFrom <= at) && (lesson.validUntil == null || at < lesson.validUntil))));
  }

  async function getSelfModel(scope, agentId, { asOf } = {}) {
    const s = readScope(scope);
    const filter = { organisationId: s.organisationId, agentId, order: 'desc', limit: 1 };
    if (asOf != null) filter.recordedTo = new Date(asOf).toISOString();
    const latest = (await store.list('self_model', filter))[0];
    return latest ? { ...latest.data, at: latest.data.at ?? latest.data.recordedAt } : null;
  }

  async function getSelfModelHistory(scope, agentId) {
    const s = readScope(scope);
    const list = await listAll('self_model', { organisationId: s.organisationId, agentId });
    return withRevisions(list, () => agentId);
  }

  async function getMemoryTimeline(scope, query = {}) {
    const s = readScope(scope);
    const axis = query.axis === 'recorded' ? 'recorded' : 'event';
    const kinds = query.kinds ?? KINDS;
    const from = query.from != null ? new Date(query.from).toISOString() : null;
    const to = query.to != null ? new Date(query.to).toISOString() : null;
    const validAt = query.validAt != null ? new Date(query.validAt).toISOString() : null;
    const base = { organisationId: s.organisationId };
    if (s.userId != null) base.userId = s.userId;
    if (query.agentId != null) base.agentId = query.agentId;
    if (query.asOf != null) base.recordedTo = new Date(query.asOf).toISOString();
    const entries = [];
    for (const kind of kinds) {
      if (!KINDS.includes(kind)) throw new ConscienceError('invalid_input', `Unknown kind "${kind}".`);
      const envelopes = (await listAll(kind, base)).filter((envelope) => visible(envelope, s));
      const byId = new Map(envelopes.map((e) => [e.id, e]));
      const groupOf = kind === 'outcome' ? (e) => `${e.decisionId}\u0000${e.data.sensor}` : kind === 'lesson' ? (e) => e.lessonId : kind === 'self_model' ? (e) => e.agentId : (e) => e.id;
      for (const record of withRevisions(envelopes, groupOf)) {
        const envelope = byId.get(record.revisionId ?? record.id);
        const validFrom = kind === 'lesson' ? record.validFrom : kind === 'outcome' ? record.observedAt : envelope.eventAt;
        const validUntil = kind === 'lesson' ? record.validUntil : kind === 'prediction' ? record.resolvesBy : null;
        entries.push({
          kind, id: record.id, revisionId: record.revisionId ?? null, revision: record.revision, current: record.current,
          decisionId: envelope.decisionId, eventAt: envelope.eventAt, recordedAt: envelope.recordedAt,
          validFrom: validFrom ?? null, validUntil: validUntil ?? null, supersededAt: record.supersededAt,
          status: record.status ?? null
        });
      }
    }
    const timeOf = (entry) => (axis === 'event' ? entry.eventAt : entry.recordedAt);
    return entries
      .filter((entry) => (from == null || (timeOf(entry) != null && timeOf(entry) >= from)) && (to == null || (timeOf(entry) != null && timeOf(entry) < to)))
      .filter((entry) => validAt == null || ((entry.validFrom == null || entry.validFrom <= validAt) && (entry.validUntil == null || validAt < entry.validUntil)))
      .sort((a, b) => ((timeOf(a) ?? '') < (timeOf(b) ?? '') ? -1 : (timeOf(a) ?? '') > (timeOf(b) ?? '') ? 1 : 0));
  }

  async function getLineage(scope, decisionId) {
    const s = readScope(scope);
    const decision = await getDecision(s, decisionId);
    if (!decision) return null;
    const related = async (kind) => (await listAll(kind, { organisationId: s.organisationId, decisionId })).filter((e) => visible(e, s));
    const predictions = (await related('prediction')).map((e) => e.data);
    const outcomes = await getOutcomes(s, decisionId);
    const corrections = (await related('correction')).map((e) => e.data);
    const refs = [decisionId, ...predictions.map((p) => p.id), ...outcomes.map((o) => o.id), ...corrections.map((c) => c.id)];
    const lessons = new Map();
    for (const ref of refs) {
      for (const lesson of await lessonsCurrent(s, { evidenceRef: ref })) if (lesson.current) lessons.set(lesson.id, lesson);
    }
    return {
      objective: decision.objective,
      decision,
      action: decision.action,
      tools: decision.tools,
      predictions,
      outcomes,
      corrections,
      lessons: await assessedLessons(s, [...lessons.values()]),
      chain: ['objective', 'action', 'tools', 'outcomes', 'corrections', 'lessons']
    };
  }

  /* ---------- erasure and retention ---------- */

  async function stripEvidence(organisationId, removedRefs) {
    let updated = 0;
    const touched = new Map();
    for (const ref of removedRefs) {
      for (const envelope of await listAll('lesson', { organisationId, evidenceRef: ref })) touched.set(envelope.id, envelope);
    }
    for (const envelope of touched.values()) {
      const evidence = envelope.data.evidence.filter((item) => !removedRefs.has(item.ref));
      const data = { ...envelope.data, evidence };
      data.sampleSize = (await lessonSample({ ...data, minimumSample: data.minimumSample ?? minimumSample })).sampleSize;
      if (data.status === 'verified' && data.sampleSize < Math.max(minimumSample, data.minimumSample ?? minimumSample)) data.status = 'hypothesis';
      if (!evidence.length) { data.status = 'hypothesis'; data.evidenceDegree = 'none'; }
      await store.replace({ ...envelope, evidenceRefs: evidence.map((item) => item.ref), data });
      updated += 1;
    }
    return updated;
  }

  async function removeWhere(kind, filter, removedRefs) {
    let total = 0;
    for (;;) {
      const page = await store.list(kind, { ...filter, limit: PAGE });
      if (!page.length) return total;
      const ids = page.map((envelope) => envelope.id);
      for (const envelope of page) removedRefs.add(kind === 'lesson' ? envelope.lessonId : envelope.id);
      const count = await store.remove(kind, filter.organisationId, ids);
      total += count;
      if (count === 0) return total;
    }
  }

  async function eraseSubject(subject = {}) {
    const { organisationId, userId } = scopeOf(subject);
    governor.assertSingleOrganisation(organisationId);
    if (!isNonEmptyString(userId)) throw new ConscienceError('invalid_input', 'eraseSubject needs organisationId and userId.');
    const removed = { decisions: 0, predictions: 0, outcomes: 0, corrections: 0, lessons: 0 };
    const removedRefs = new Set();
    let anonymised = 0;
    if (retention.erasure === 'anonymise') {
      for (const kind of ['decision', 'prediction', 'outcome', 'correction', 'lesson']) {
        for (const envelope of await listAll(kind, { organisationId, userId })) {
          await store.replace({ ...envelope, userId: null, data: { ...envelope.data, userId: null, subjectErased: true } });
          anonymised += 1;
        }
      }
    } else {
      const decisions = await listAll('decision', { organisationId, userId });
      const decisionIds = decisions.map((envelope) => envelope.id);
      for (const [kind, key] of [['prediction', 'predictions'], ['outcome', 'outcomes'], ['correction', 'corrections']]) {
        removed[key] += await removeWhere(kind, { organisationId, userId }, removedRefs);
        if (decisionIds.length) removed[key] += await removeWhere(kind, { organisationId, decisionIds }, removedRefs);
      }
      removed.decisions = await removeWhere('decision', { organisationId, userId }, removedRefs);
      removed.lessons = await removeWhere('lesson', { organisationId, userId }, removedRefs);
    }
    const lessonsUpdated = removedRefs.size ? await stripEvidence(organisationId, removedRefs) : 0;
    const extensions = [];
    for (const eraser of erasers) {
      const result = await eraser({ organisationId, userId });
      extensions.push({ name: String(result?.name ?? 'extension'), count: Number(result?.count ?? 0) });
    }
    const report = { organisationId, mode: retention.erasure, removed, anonymised, lessonsUpdated, extensions, completedAt: iso() };
    await emit({ action: 'erased', organisationId, removed: { ...removed }, anonymised, lessonsUpdated });
    return report;
  }

  async function applyRetention({ organisationId } = {}) {
    governor.assertSingleOrganisation(organisationId);
    const removed = {};
    const removedRefs = new Set();
    for (const [kind, days] of Object.entries(retention.maxAgeDays)) {
      const cutoff = new Date(now() - days * 86400000).toISOString();
      removed[kind] = 0;
      for (;;) {
        const page = (await store.list(kind, { organisationId, recordedTo: cutoff, limit: PAGE })).filter((envelope) => envelope.recordedAt < cutoff);
        if (!page.length) break;
        for (const envelope of page) removedRefs.add(kind === 'lesson' ? envelope.lessonId : envelope.id);
        const count = await store.remove(kind, organisationId, page.map((envelope) => envelope.id));
        removed[kind] += count;
        if (count === 0) break;
      }
    }
    const lessonsUpdated = removedRefs.size ? await stripEvidence(organisationId, removedRefs) : 0;
    await emit({ action: 'retention', organisationId, removed: { ...removed } });
    return { organisationId, removed, lessonsUpdated, completedAt: iso() };
  }

  return Object.freeze({
    store, governor, retention: copy(retention),
    recordDecision, recordPrediction, attachOutcome, recordCorrection,
    recordLesson, resolveLessonConflict, updateSelfModel,
    getDecision, getOutcomes, recallDecisions, getLesson, listLessons, getSelfModel, getSelfModelHistory,
    getMemoryTimeline, getLineage,
    eraseSubject, applyRetention
  });
}

module.exports = { createConscience, ERASURE_MODES };
