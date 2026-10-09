'use strict';
const { assertGovernorReady } = require('../governor/governor');
const { fingerprintOf } = require('../governor/util');
const statistics = require('./statistics');
const signals = require('./signals');
const lessons = require('./lessons');
const { invalid } = statistics;
const { ConscienceError } = require('../errors');
const AVAILABLE_FROM = 'P2';

/** Evaluate stored P1 records without persisting derived data or drawing causal conclusions. */
async function evaluateOutcomes(options = {}) {
  await assertGovernorReady(options.governor, { organisationId: options.organisationId });
  const { conscience, organisationId, userId, agentId } = options;
  let window = options.window;
  options.governor.assertSingleOrganisation(organisationId);
  if (!conscience || conscience.governor !== options.governor) invalid('conscience must use the supplied governor.');
  statistics.minimum(options.minimumSample);
  if (window && (!Number.isFinite(Date.parse(window.from)) || !Number.isFinite(Date.parse(window.to)) || Date.parse(window.from) >= Date.parse(window.to))) invalid('Invalid evaluation window.');
  if (window) window = { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() };
  const scope = { organisationId, userId };
  let decisions;
  if (options.decisionIds) {
    if (!Array.isArray(options.decisionIds) || !options.decisionIds.every((id) => typeof id === 'string')) invalid('decisionIds must be strings.');
    decisions = (await Promise.all([...new Set(options.decisionIds)].map((id) => conscience.getDecision(scope, id)))).filter(Boolean);
    decisions = decisions.filter((d) => (!agentId || d.agentId === agentId) && (!window || (d.decidedAt >= window.from && d.decidedAt < window.to)));
  } else {
    decisions = await conscience.recallDecisions(scope, { agentId, from: window?.from, to: window?.to, limit: 1000, order: 'asc' });
    if (decisions.length === 1000) throw new ConscienceError('evaluation_limit', 'Use explicit decisionIds to evaluate 1000 or more decisions without truncation.');
  }
  const inScope = (record) => {
    if (typeof record.organisationId !== 'string' || !record.organisationId.trim()) invalid('Evaluation configuration requires organisationId.');
    options.governor.assertSingleOrganisation(organisationId, record.organisationId);
    if (userId != null && record.userId != null && record.userId !== userId) invalid('Cross-person evaluation input.');
  };
  for (const list of [options.calendars ?? [], options.errorCostPolicies ?? [], options.reflectionRuns ?? []]) for (const r of list) inScope(r);
  const findings = [], points = [], allTraces = [], currentLessons = await conscience.listLessons(scope, { agentId });
  const runId = options.runId ?? `evaluation_${fingerprintOf({ organisationId, userId, agentId, window, decisionIds: decisions.map((d) => d.id) }).slice(0, 24)}`;
  const add = (kind, data) => {
    const content = { runId, organisationId, kind, decisionIds: [], observation: kind, evidence: [], evidenceDegree: 'observational', confidence: 0,
      severity: 'low', sampleSize: 0, interval: null, status: 'observed', causality: 'not_established',
      competingExplanations: ['chance', 'environment', 'decision_method'], confounders: [], ...data };
    findings.push({ id: `finding_${fingerprintOf(content).slice(0, 24)}`, ...content });
  };
  for (const d of decisions) {
    options.signal?.throwIfAborted();
    const lineage = await conscience.getLineage(scope, d.id);
    const outcomes = lineage.outcomes.filter((o) => o.current);
    const predictions = [...lineage.predictions].sort((a, b) => a.madeAt.localeCompare(b.madeAt) || a.id.localeCompare(b.id));
    const last = new Map();
    for (const p of predictions) last.set(p.domain ?? d.domain ?? 'general', p);
    for (const [domain, p] of last) {
      const matched = outcomes.filter((o) => (!p.sensor || p.sensor === o.sensor) && (!o.predictionId || o.predictionId === p.id));
      const o = matched.length === 1 ? matched[0] : null;
      // A prediction made after observing its outcome cannot be calibrated.
      const status = o && p.madeAt <= o.observedAt ? o.status : 'unknown';
      points.push({ decisionId: d.id, predictionId: p.id, outcomeId: o?.id ?? null, agentId: d.agentId, domain, probability: p.probability, status });
    }
    const traces = d.toolTrace ?? [];
    allTraces.push(...traces);
    const fidelity = signals.checkReasoningFidelity(d.justification, traces, options.claimRules);
    if (fidelity.status !== 'unknown') add('reasoning_fidelity', { decisionIds: [d.id], evidence: [{ kind: 'decision', ref: d.id }], sampleSize: 1,
      confidence: 1, status: fidelity.status, severity: fidelity.status === 'unfaithful' ? 'high' : 'low', details: fidelity });
    for (const o of outcomes) {
      const calendar = signals.calendarConfounders(d.domain ?? 'general', o.observedAt, options.calendars);
      add('outcome', { decisionIds: [d.id], evidence: [{ kind: 'outcome', ref: o.id }], sampleSize: o.status === 'unknown' ? 0 : 1,
        confidence: o.status === 'unknown' ? 0 : 1 - (o.uncertainty ?? 0), status: calendar.status === 'calendar_confounded' ? calendar.status : o.status,
        confounders: [...o.confounders, ...calendar.periods.map((p) => p.label)], competingExplanations: options.competingExplanations ?? ['chance', 'environment', 'decision_method'],
        details: { outcomeStatus: o.status, methodStatus: fidelity.status, calendar, generalRule: null } });
    }
    for (const c of lineage.corrections) add('correction', { decisionIds: [d.id], evidence: [{ kind: 'correction', ref: c.id }], sampleSize: 1,
      status: 'observed', confidence: 1, details: { class: signals.classifyCorrection(c), factualLessonEligible: c.class === 'factual' } });
  }
  for (const calibration of statistics.calibratePredictions(points, options)) {
    const group = points.filter((p) => p.agentId === calibration.agentId && p.domain === calibration.domain);
    add('calibration', { agentId: calibration.agentId, domain: calibration.domain, decisionIds: group.map((p) => p.decisionId),
      evidence: group.flatMap((p) => [{ kind: 'prediction', ref: p.predictionId }, ...(p.outcomeId ? [{ kind: 'outcome', ref: p.outcomeId }] : [])]),
      sampleSize: calibration.sampleSize, interval: calibration.interval, status: calibration.status,
      confidence: calibration.status === 'observed' ? calibration.interval.level : 0, details: calibration });
    const policies = (options.errorCostPolicies ?? []).filter((p) => p.domain === calibration.domain && (!p.agentId || p.agentId === calibration.agentId));
    if (policies.length > 1) invalid('Ambiguous error cost policy.');
    if (policies.length) add('error_cost', { agentId: calibration.agentId, domain: calibration.domain, sampleSize: calibration.sampleSize,
      decisionIds: group.map((p) => p.decisionId), evidence: group.filter((p) => p.outcomeId).map((p) => ({ kind: 'outcome', ref: p.outcomeId })),
      status: calibration.status, details: statistics.scoreErrorCosts(group, policies[0], options) });
  }
  for (const reliability of signals.toolReliability(allTraces, options)) add('tool_reliability', {
    sampleSize: reliability.knownCalls, interval: reliability.errorStatistics.interval, status: reliability.errorStatistics.status, details: reliability,
    evidence: decisions.filter((d) => (d.toolTrace ?? []).some((t) => t.tool === reliability.tool && (t.provider ?? null) === reliability.provider)).map((d) => ({ kind: 'decision', ref: d.id })) });
  for (const conflict of lessons.evaluateLessonConflicts(currentLessons, options)) add('contradiction', { status: 'to_reassess', evidence: conflict.evidence, details: conflict });
  if (options.targetMetric) {
    const check = signals.checkCounterMetrics(options.targetMetric, options.counterMetrics ?? []);
    add('anti_goodhart', { status: check.status, details: check });
  }
  const runs = (options.reflectionRuns ?? []).filter((r) => !agentId || r.agentId === agentId);
  if (runs.length) add('reflection_quality', { evidence: runs.map((r) => ({ kind: 'external', ref: r.id })), sampleSize: runs.filter((r) => r.status === 'completed').length,
    details: { runs: runs.map((r) => ({ id: r.id, ...signals.reflectionUtility(r, options) })), frequency: signals.recommendReflectionFrequency(runs, options) } });
  return findings;
}
async function runReflection(options) { return evaluateOutcomes(options); }
function createEvaluator(options) {
  return Object.freeze({ evaluate: (input) => evaluateOutcomes({ ...options, ...input, governor: options.governor, conscience: options.conscience }) });
}
module.exports = { runReflection, evaluateOutcomes, createEvaluator, AVAILABLE_FROM,
  wilsonInterval: statistics.wilsonInterval, honestStatistics: statistics.honestStatistics,
  calibratePredictions: statistics.calibratePredictions, scoreErrorCosts: statistics.scoreErrorCosts, ...signals, ...lessons };

// P3 experiments (first half); append-only integration with the evaluation core.
const { createSandbox } = require('./experiments/sandbox');
const { replayDecisions } = require('./experiments/replay');
const { createHoldout } = require('./experiments/holdout');
const { proposeExperiment, runExperiment } = require('./experiments/laboratory');
Object.assign(module.exports, { createSandbox, replayDecisions, createHoldout, proposeExperiment, runExperiment });
