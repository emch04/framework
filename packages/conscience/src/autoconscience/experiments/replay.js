'use strict';
const { ready, fail, date, data, agentSource, invalid, fingerprintOf } = require('./common');
const { createSandbox, sandboxState } = require('./sandbox');
const { execute } = require('./execution');
const FACT_DATES = new Set(['at', 'recordedAt', 'observedAt', 'decidedAt', 'madeAt', 'correctedAt', 'knownAt', 'availableAt', 'testedAt', 'createdAt', 'validFrom']);
/** Validate factual availability recursively; planned horizons/expiry dates are not facts from the future. */
function temporal(value, cutoff) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FACT_DATES.has(key) && child != null && date(child, key) > cutoff) fail('future_data', 'Replay contains information unavailable at the decision date.');
    if (child && typeof child === 'object') temporal(child, cutoff);
  }
}
function scoped(record, options) {
  options.governor.assertSingleOrganisation(options.organisationId, record.organisationId);
  if (!record.organisationId) invalid('Replay data needs organisationId.');
  if (options.userId != null && record.userId !== options.userId) fail('cross_person', 'Replay data belongs to another person.');
}
async function list(store, kind, filter) {
  const result = await store.list(kind, { ...filter, limit: 10000, order: 'asc' });
  if (result.length >= 10000) fail('replay_limit', 'Narrow the replay scope to avoid truncation.');
  return result;
}
async function replayDecisions(options = {}) {
  await ready(options);
  const { governor, conscience } = options;
  if (!conscience || conscience.governor !== governor) invalid('conscience must use the supplied governor.');
  const asOf = date(options.asOf, 'asOf');
  const source = agentSource(options.proposal?.agent);
  const information = data(options.proposal?.information ?? []);
  if (!Array.isArray(information)) invalid('proposal.information must be dated data.');
  if (Boolean(options.decisionIds) === Boolean(options.window)) invalid('Choose decisionIds or window, exclusively.');
  const scope = { organisationId: options.organisationId, ...(options.userId != null ? { userId: options.userId } : {}) };
  let decisions;
  if (options.decisionIds) {
    if (!Array.isArray(options.decisionIds) || !options.decisionIds.length || !options.decisionIds.every((id) => typeof id === 'string' && id.trim())) invalid('decisionIds must be a non-empty list of ids.');
    decisions = await Promise.all([...new Set(options.decisionIds)].map((id) => conscience.getDecision(scope, id)));
    if (decisions.some((d) => !d)) fail('not_found', 'A replay decision is unavailable in this scope.');
  } else {
    const from = date(options.window.from, 'window.from'), to = date(options.window.to, 'window.to');
    if (from >= to) invalid('Replay window must be non-empty.');
    decisions = (await list(conscience.store, 'decision', { ...scope, agentId: options.agentId, eventFrom: from, eventTo: to })).map((r) => r.data);
  }
  if (options.agentId && decisions.some((d) => d.agentId !== options.agentId)) invalid('Replay agent mismatch.');
  const snapshots = data(options.snapshots ?? {});
  const sandbox = options.sandbox ?? await createSandbox({ ...scope, governor, tools: options.tools });
  const { config } = await sandboxState(sandbox, { ...scope, governor });
  const cases = [];
  // Validate every case before running any candidate: contaminated batches never partly execute.
  const prepared = [];
  for (const raw of decisions) {
    const d = data(raw), cutoff = date(d.decidedAt, 'decidedAt');
    scoped(d, options);
    if (cutoff > asOf) fail('future_data', 'The decision is later than asOf.');
    temporal(d, cutoff);
    temporal(config, cutoff);
    for (const tool of Object.values(config)) {
      if (tool.kind !== 'read') continue;
      const responses = [...(tool.recordings ?? []).map((r) => r.output), ...(Object.hasOwn(tool, 'response') ? [tool.response] : [])];
      for (const response of responses) {
        if (!response || typeof response !== 'object' || response.at == null || response.recordedAt == null || !Object.hasOwn(response, 'data')) fail('temporal_metadata_required', 'Replay read responses need organisationId, at, recordedAt and data.');
        scoped(response, options); date(response.at, 'tool.at'); date(response.recordedAt, 'tool.recordedAt');
      }
    }
    const snapshot = d.inputSnapshotRef ? snapshots[d.inputSnapshotRef] : { ...scope, at: d.context.at, recordedAt: d.recordedAt, data: d.context.data };
    if (!snapshot) fail('snapshot_missing', 'The referenced input snapshot is required.');
    scoped(snapshot, options);
    date(snapshot.at, 'snapshot.at'); date(snapshot.recordedAt, 'snapshot.recordedAt');
    if (!Object.hasOwn(snapshot, 'data')) invalid('Snapshot needs data.');
    temporal(snapshot, cutoff);
    for (const item of information) {
      scoped(item, options); date(item.at, 'information.at'); date(item.recordedAt, 'information.recordedAt'); temporal(item, cutoff);
    }
    const filter = { ...scope, agentId: d.agentId, recordedTo: cutoff };
    const historicalDecisions = await list(conscience.store, 'decision', filter);
    const knownIds = new Set(historicalDecisions.filter((r) => r.data.decidedAt <= cutoff).map((r) => r.id));
    const outcomeRows = await list(conscience.store, 'outcome', filter);
    const latest = new Map();
    for (const row of outcomeRows) {
      if (!knownIds.has(row.decisionId)) continue;
      scoped(row.data, options); temporal(row.data, cutoff);
      latest.set(JSON.stringify([row.decisionId, row.data.sensor]), data(row.data));
    }
    // Load stored revisions directly: derived P2 status must not disclose later evidence.
    const lessonRows = await list(conscience.store, 'lesson', { ...scope, recordedTo: cutoff });
    const latestLessons = new Map();
    for (const row of lessonRows) if (row.agentId == null || row.agentId === d.agentId) latestLessons.set(row.lessonId, row.data);
    const lessons = [];
    for (const rawLesson of latestLessons.values()) {
      if (rawLesson.status === 'retired' || (rawLesson.validFrom && rawLesson.validFrom > cutoff) || (rawLesson.validUntil && rawLesson.validUntil <= cutoff)) continue;
      const lesson = data(rawLesson); scoped(lesson, options); temporal(lesson, cutoff);
      for (const proof of lesson.evidence) {
        if (proof.kind === 'external') fail('temporal_evidence_required', 'External lesson evidence needs a dated internal record for replay.');
        const record = await conscience.store.get(proof.kind, options.organisationId, proof.ref);
        if (!record) fail('temporal_evidence_required', 'Historical lesson evidence is unavailable.');
        scoped(record.data, options); temporal(record.data, cutoff);
      }
      lessons.push(lesson);
    }
    const input = { inputs: snapshot.data, outcomes: [...latest.values()], lessons, information,
      decision: { id: d.id, objective: d.objective, context: d.context, versions: d.versions, permissions: d.permissions }, asOf: cutoff };
    prepared.push({ d, input });
  }
  for (const { d, input } of prepared) {
    const result = await execute({ ...scope, governor, source, input, config, timeoutMs: options.timeoutMs });
    const expected = { name: d.action.name, input: d.action.input };
    cases.push({ decisionId: d.id, asOf: d.decidedAt, status: result.status,
      compatible: result.status === 'completed' && Object.hasOwn(result, 'output') ? fingerprintOf(result.output) === fingerprintOf(expected) : null,
      ...(Object.hasOwn(result, 'output') ? { output: result.output } : {}), intentions: result.intentions, journal: result.journal ?? [] });
  }
  return { purpose: 'compatibility_only', provesProgress: false, causality: 'not_established', sandbox: true, cases };
}
module.exports = { replayDecisions };
