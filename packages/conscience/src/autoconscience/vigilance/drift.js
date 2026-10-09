'use strict';
/*
 * Drift watch (proposition 17). Compares a baseline window with a current
 * window on three families of signals:
 *   - inputs: distribution of domains and of languages, length of requests;
 *   - outcomes: rate of succeeded / failed (and the share of unknown);
 *   - performance: calibration (Brier score, confidence gap) and tool reliability.
 *
 * Tests, all simple and documented:
 *   - Population Stability Index (PSI) for distributions. Each category gets a
 *     0.5 pseudo-count so an empty category never gives an infinite value.
 *     Conventional reading: PSI < 0.10 stable, 0.10 to 0.25 moderate shift,
 *     >= 0.25 significant shift. Lengths are cut into bins at the baseline
 *     quintiles.
 *   - Difference of two proportions with Newcombe's hybrid score interval,
 *     built from the two Wilson intervals (the same Wilson as P2). A shift is
 *     "significant" when the interval excludes zero and the gap is at least
 *     `minimumEffect` (default 5 points); statistically visible but tiny gaps
 *     stay "moderate".
 *   - Brier score and confidence gap: plain difference against a threshold
 *     (they come from P2 summaries, there is no raw sample to test).
 *
 * A window with fewer known observations than `minimumSample` never concludes.
 * A business calendar (P2) is consulted BEFORE blaming the agent: a calendar
 * period that overlaps the current window but not the baseline explains the
 * shift. The result is a coded recommendation (monitor / freeze / investigate /
 * propose_rollback). Nothing is applied here: a rollback is only ever a
 * proposal handed to the governor.
 */
const { wilsonInterval, minimum, number } = require('../statistics');
const { ready, invalid, actorOf, isoOf } = require('./common');

const RECOMMENDATIONS = Object.freeze(['monitor', 'freeze', 'investigate', 'propose_rollback']);
const PSI_MODERATE = 0.1;
const PSI_SIGNIFICANT = 0.25;

const round = (value) => Math.round(value * 1e6) / 1e6;
const total = (counts) => Object.values(counts).reduce((sum, value) => sum + value, 0);

function counts(value, name) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must map a category to a count.`);
  for (const [key, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) invalid(`${name}.${key} must be a finite count >= 0.`);
  }
  return value;
}

/** Population Stability Index of two count tables, with its biggest contributors. */
function populationStabilityIndex(baseline, current) {
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  const bt = total(baseline), ct = total(current), k = keys.length;
  if (!k || bt <= 0 || ct <= 0) return null;
  const parts = keys.map((key) => {
    const pb = ((baseline[key] ?? 0) + 0.5) / (bt + 0.5 * k);
    const pc = ((current[key] ?? 0) + 0.5) / (ct + 0.5 * k);
    return { category: key, baseline: round(pb), current: round(pc), contribution: (pc - pb) * Math.log(pc / pb) };
  });
  const value = parts.reduce((sum, part) => sum + part.contribution, 0);
  const top = [...parts].sort((a, b) => b.contribution - a.contribution || (a.category < b.category ? -1 : 1)).slice(0, 3)
    .map((part) => ({ ...part, contribution: round(part.contribution) }));
  return { psi: value, categories: k, top };
}

/** Newcombe hybrid score interval for p2 - p1 (Wilson intervals of each proportion). */
function differenceInterval(s1, n1, s2, n2, level = 0.95) {
  const a = wilsonInterval(s1, n1, level), b = wilsonInterval(s2, n2, level);
  const p1 = s1 / n1, p2 = s2 / n2, d = p2 - p1;
  return { difference: d, low: d - Math.sqrt((p2 - b.low) ** 2 + (a.high - p1) ** 2), high: d + Math.sqrt((b.high - p2) ** 2 + (p1 - a.low) ** 2), level };
}

const levelOfPsi = (psi) => (psi >= PSI_SIGNIFICANT ? 'significant' : psi >= PSI_MODERATE ? 'moderate' : 'none');

function signal(fields) {
  return { drifted: fields.level === 'none' ? false : fields.level == null ? null : true, ...fields };
}
const insufficient = (id, dimension, metric, test, baselineSample, currentSample, threshold) => signal({
  id, dimension, metric, test, status: 'insufficient_data', level: null, statistic: null, direction: null, baselineSample, currentSample, threshold, details: null
});

function distributionSignal(id, dimension, metric, base, cur, minimumSample) {
  const bt = total(base), ct = total(cur);
  if (bt < minimumSample || ct < minimumSample) return insufficient(id, dimension, metric, 'psi', bt, ct, PSI_SIGNIFICANT);
  const result = populationStabilityIndex(base, cur);
  return signal({ id, dimension, metric, test: 'psi', status: 'observed', statistic: round(result.psi), level: levelOfPsi(result.psi),
    direction: 'shift', baselineSample: bt, currentSample: ct, threshold: PSI_SIGNIFICANT, details: { moderateFrom: PSI_MODERATE, top: result.top } });
}

function lengthBins(baseline, current) {
  const sorted = [...baseline].sort((a, b) => a - b);
  const edges = [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]))];
  const label = (value) => { const index = edges.findIndex((edge) => value <= edge); return `bin_${index === -1 ? edges.length : index}`; };
  const table = (values) => { const out = {}; for (const v of values) out[label(v)] = (out[label(v)] ?? 0) + 1; return out; };
  return { base: table(baseline), cur: table(current), edges };
}

function lengthsOf(value, name) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) invalid(`${name} must be an array of finite lengths >= 0.`);
  return value;
}

function proportionSignal(id, dimension, metric, base, cur, options, { minimumEffect, goodDirection }) {
  const [bs, bn] = base, [cs, cn] = cur;
  if (bn < options.minimumSample || cn < options.minimumSample) return insufficient(id, dimension, metric, 'newcombe_difference', bn, cn, minimumEffect);
  const interval = differenceInterval(bs, bn, cs, cn, options.level);
  const excludesZero = interval.low > 0 || interval.high < 0;
  const gap = Math.abs(interval.difference);
  const level = excludesZero ? (gap >= minimumEffect ? 'significant' : 'moderate') : 'none';
  const direction = interval.difference === 0 ? 'unchanged' : interval.difference * goodDirection > 0 ? 'improvement' : 'degradation';
  return signal({ id, dimension, metric, test: 'newcombe_difference', status: 'observed', statistic: round(interval.difference), level,
    direction, baselineSample: bn, currentSample: cn, threshold: minimumEffect,
    details: { baselineRate: round(bs / bn), currentRate: round(cs / cn), interval: { low: round(interval.low), high: round(interval.high), level: interval.level } } });
}

function outcomeCounts(value, name) {
  if (value == null) return null;
  counts(value, name);
  for (const key of ['succeeded', 'failed']) if (typeof value[key] !== 'number') invalid(`${name}.${key} is required.`);
  return { succeeded: value.succeeded, failed: value.failed, unknown: value.unknown ?? 0 };
}

function toolKey(t) { return JSON.stringify([t.tool, t.provider ?? null]); }

function windowOf(win, name) {
  if (win == null) return null;
  const from = Date.parse(win.from), to = Date.parse(win.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) invalid(`${name}.window must be { from, to } with from before to.`);
  return { from, to, iso: { from: new Date(from).toISOString(), to: new Date(to).toISOString() } };
}

/** Calendar periods of this domain that overlap the current window and not the baseline one. */
function explainingPeriods(governor, organisationId, domain, calendars, baseWindow, curWindow) {
  const overlaps = (period, win) => Date.parse(period.from) < win.to && win.from < Date.parse(period.to);
  const out = [];
  for (const calendar of calendars) {
    governor.assertSingleOrganisation(organisationId, calendar.organisationId);
    if (calendar.domain !== domain) continue;
    for (const period of calendar.periods) {
      const from = Date.parse(period.from), to = Date.parse(period.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) invalid('Invalid calendar period.');
      if (overlaps(period, curWindow) && !overlaps(period, baseWindow)) out.push({ calendar: calendar.name, label: period.label, from: period.from, to: period.to, kind: period.kind ?? null });
    }
  }
  return out;
}

/**
 * Build a window summary from P2 material. `decisions` are the decisions of the
 * window, `findings` the P2 findings computed on that same window. `languageOf`
 * is injected (the core detects no language).
 */
function snapshotWindow({ decisions = [], findings = [], agentId, domain, languageOf, window } = {}) {
  const domains = {}, languages = {}, lengths = [];
  for (const d of decisions) {
    if (agentId && d.agentId !== agentId) continue;
    const name = d.domain ?? 'general';
    domains[name] = (domains[name] ?? 0) + 1;
    lengths.push(String(d.objective ?? '').length);
    if (typeof languageOf === 'function') { const lang = languageOf(d); if (lang) languages[lang] = (languages[lang] ?? 0) + 1; }
  }
  const outcomes = { succeeded: 0, failed: 0, unknown: 0 };
  for (const f of findings) if (f.kind === 'outcome' && Object.hasOwn(outcomes, f.details?.outcomeStatus)) outcomes[f.details.outcomeStatus] += 1;
  const calibration = findings.find((f) => f.kind === 'calibration' && (!agentId || f.agentId === agentId) && (!domain || f.domain === domain))?.details ?? null;
  const tools = findings.filter((f) => f.kind === 'tool_reliability').map((f) => ({ tool: f.details.tool, provider: f.details.provider, knownCalls: f.details.knownCalls, failures: f.details.failures }));
  return {
    window: window ?? null, inputs: { domains, languages: typeof languageOf === 'function' ? languages : undefined, lengths }, outcomes,
    performance: { calibration: calibration && { sampleSize: calibration.sampleSize, brierScore: calibration.brierScore, confidenceGap: calibration.confidenceGap }, tools }
  };
}

/**
 * Detect drift. Needs a genuine, running governor. Returns data only:
 * `applied` is always false. With `propose` and a `recentChange`, a rollback
 * recommendation becomes a pending proposal at the governor; nothing else.
 */
async function detectDrift(options = {}) {
  const { governor, organisationId, agentId, domain, baseline, current } = options;
  await ready(governor, organisationId);
  if (typeof agentId !== 'string' || !agentId) invalid('agentId is required.');
  if (typeof domain !== 'string' || !domain) invalid('domain is required.');
  if (!baseline || !current || typeof baseline !== 'object' || typeof current !== 'object') invalid('baseline and current summaries are required.');
  const minimumSample = minimum(options.minimumSample);
  const level = options.level ?? 0.95;
  wilsonInterval(0, 1, level);
  const minimumEffect = number(options.minimumEffect ?? 0.05, 'minimumEffect', 0, 1);
  const brierDelta = number(options.brierDelta ?? 0.05, 'brierDelta', 0, 1);
  const gapDelta = number(options.confidenceGapDelta ?? 0.1, 'confidenceGapDelta', 0, 1);
  const freezeDrop = number(options.freezeDrop ?? 0.15, 'freezeDrop', 0, 1);
  const settings = { minimumSample, level };
  const calendars = options.calendars ?? [];
  if (!Array.isArray(calendars)) invalid('calendars must be an array.');

  const signals = [];
  /* ---- inputs ---- */
  for (const [key, metric] of [['domains', 'domain_mix'], ['languages', 'language_mix']]) {
    const b = counts(baseline.inputs?.[key], `baseline.inputs.${key}`), c = counts(current.inputs?.[key], `current.inputs.${key}`);
    if (b && c) signals.push(distributionSignal(`inputs.${metric}`, 'inputs', metric, b, c, minimumSample));
  }
  const bl = lengthsOf(baseline.inputs?.lengths, 'baseline.inputs.lengths'), cl = lengthsOf(current.inputs?.lengths, 'current.inputs.lengths');
  if (bl && cl) {
    if (bl.length < minimumSample || cl.length < minimumSample) signals.push(insufficient('inputs.length', 'inputs', 'length', 'psi', bl.length, cl.length, PSI_SIGNIFICANT));
    else { const bins = lengthBins(bl, cl); const s = distributionSignal('inputs.length', 'inputs', 'length', bins.base, bins.cur, 1); s.details.binEdges = bins.edges; signals.push(s); }
  }
  /* ---- outcomes ---- */
  const bo = outcomeCounts(baseline.outcomes, 'baseline.outcomes'), co = outcomeCounts(current.outcomes, 'current.outcomes');
  if (bo && co) {
    signals.push(proportionSignal('outcomes.success_rate', 'outcomes', 'success_rate', [bo.succeeded, bo.succeeded + bo.failed], [co.succeeded, co.succeeded + co.failed], settings, { minimumEffect, goodDirection: 1 }));
    const bAll = bo.succeeded + bo.failed + bo.unknown, cAll = co.succeeded + co.failed + co.unknown;
    signals.push(proportionSignal('outcomes.unknown_rate', 'outcomes', 'unknown_rate', [bo.unknown, bAll], [co.unknown, cAll], settings, { minimumEffect, goodDirection: -1 }));
  }
  /* ---- performance ---- */
  const bc = baseline.performance?.calibration, cc = current.performance?.calibration;
  if (bc && cc) {
    const enough = (bc.sampleSize ?? 0) >= minimumSample && (cc.sampleSize ?? 0) >= minimumSample;
    const delta = (id, metric, base, cur, threshold, signed) => {
      if (!enough || base == null || cur == null) return insufficient(id, 'performance', metric, 'threshold_difference', bc.sampleSize ?? 0, cc.sampleSize ?? 0, threshold);
      const diff = signed(cur) - signed(base);
      const lvl = diff >= threshold ? 'significant' : diff >= threshold / 2 ? 'moderate' : 'none';
      return signal({ id, dimension: 'performance', metric, test: 'threshold_difference', status: 'observed', statistic: round(cur - base), level: lvl,
        direction: diff > 0 ? 'degradation' : diff < 0 ? 'improvement' : 'unchanged', baselineSample: bc.sampleSize, currentSample: cc.sampleSize, threshold,
        details: { baseline: base, current: cur } });
    };
    signals.push(delta('performance.brier_score', 'brier_score', bc.brierScore, cc.brierScore, brierDelta, (v) => v));
    signals.push(delta('performance.overconfidence', 'overconfidence', bc.confidenceGap, cc.confidenceGap, gapDelta, (v) => v));
  }
  const bt = new Map((baseline.performance?.tools ?? []).map((t) => [toolKey(t), t]));
  for (const t of current.performance?.tools ?? []) {
    const before = bt.get(toolKey(t));
    if (!before) continue;
    signals.push(proportionSignal(`performance.tool_errors[${t.tool}|${t.provider ?? ''}]`, 'performance', 'tool_error_rate', [before.failures, before.knownCalls], [t.failures, t.knownCalls], settings,
      { minimumEffect, goodDirection: -1 }));
  }
  signals.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /* ---- reading of the signals ---- */
  const significant = (dimension, test = () => true) => signals.some((s) => s.dimension === dimension && s.level === 'significant' && test(s));
  const worse = (s) => s.direction === 'degradation';
  const inputsDrift = significant('inputs');
  const outcomeDegraded = signals.some((s) => s.id === 'outcomes.success_rate' && s.level === 'significant' && worse(s));
  const calibrationDegraded = significant('performance', (s) => s.test === 'threshold_difference' && worse(s));
  const toolDegraded = significant('performance', (s) => s.metric === 'tool_error_rate' && worse(s));
  const anySignificant = signals.some((s) => s.level === 'significant');
  const anyModerate = signals.some((s) => s.level === 'moderate');
  const evaluated = signals.some((s) => s.status === 'observed');
  const status = !evaluated ? 'insufficient_data' : anySignificant ? 'drift' : anyModerate ? 'watch' : 'stable';

  /* ---- calendar first ---- */
  const baseWindow = windowOf(baseline.window, 'baseline'), curWindow = windowOf(current.window, 'current');
  let calendar = { status: 'not_checked', periods: [] };
  if (calendars.length) {
    if (!baseWindow || !curWindow) invalid('A calendar check needs baseline.window and current.window.');
    const periods = explainingPeriods(governor, organisationId, domain, calendars, baseWindow, curWindow);
    calendar = { status: periods.length ? 'explains' : 'does_not_explain', periods };
  }
  const drifting = status === 'drift' || status === 'watch';
  const explained = drifting && calendar.status === 'explains';

  /* ---- recommendation ---- */
  const degraded = outcomeDegraded || calibrationDegraded || toolDegraded;
  const reasons = [];
  let recommendation = 'monitor';
  let change = options.recentChange ?? null;
  if (change) {
    if (typeof change !== 'object' || !['kind', 'id', 'version', 'previousVersion'].every((k) => typeof change[k] === 'string' && change[k])) invalid('recentChange needs kind, id, version and previousVersion.');
    change = { kind: change.kind, id: change.id, version: change.version, previousVersion: change.previousVersion, deployedAt: isoOf(change.deployedAt, 'recentChange.deployedAt') };
  }
  const afterChange = Boolean(change && curWindow && curWindow.from >= Date.parse(change.deployedAt));
  const drop = signals.find((s) => s.id === 'outcomes.success_rate' && s.level === 'significant' && worse(s));
  if (status === 'insufficient_data') reasons.push('insufficient_data');
  else if (!drifting) reasons.push('no_drift');
  else if (explained) reasons.push('calendar_explained');
  else if (!degraded) reasons.push(inputsDrift ? 'inputs_shift_only' : 'watch_only');
  else if (inputsDrift || toolDegraded) { recommendation = 'investigate'; reasons.push(...[inputsDrift && 'inputs_shift', toolDegraded && 'tool_degradation', outcomeDegraded && 'outcome_decline', calibrationDegraded && 'calibration_decline'].filter(Boolean)); }
  else if (afterChange) { recommendation = 'propose_rollback'; reasons.push('degradation_after_change'); }
  else if (drop && Math.abs(drop.statistic) >= freezeDrop) { recommendation = 'freeze'; reasons.push('severe_outcome_decline'); }
  else { recommendation = 'investigate'; reasons.push(...[outcomeDegraded && 'outcome_decline', calibrationDegraded && 'calibration_decline'].filter(Boolean)); }

  const result = {
    organisationId, agentId, domain, status, signals, calendar,
    attribution: explained ? 'calendar' : status === 'drift' || status === 'watch' ? 'agent_or_environment' : 'none',
    reexamineAfter: explained ? calendar.periods.map((p) => p.to).sort().at(-1) : null,
    recommendation, reasons, recentChange: change, applied: false, proposal: null, finding: null
  };

  if (options.propose && recommendation === 'propose_rollback') {
    const proposedBy = actorOf(options.propose.proposedBy, { kind: 'engine', id: 'drift-watch' });
    result.proposal = await governor.evaluatePolicy({
      organisationId, target: { kind: change.kind, id: change.id, version: change.version },
      change: { revertTo: change.previousVersion, from: change.version },
      justification: { code: 'drift_detected', agentId, domain, signals: signals.filter((s) => s.level === 'significant').map((s) => ({ id: s.id, statistic: s.statistic, direction: s.direction })) },
      rollback: { revertTo: change.previousVersion }, risk: options.propose.risk ?? 'high', proposedBy, owner: options.propose.owner ?? null
    });
  }
  if (options.recordedBy && drifting) {
    result.finding = await governor.recordFinding({
      organisationId, runId: options.runId ?? null, code: explained ? 'drift_calendar_explained' : 'drift_detected',
      severity: recommendation === 'monitor' ? 'info' : recommendation === 'investigate' ? 'medium' : 'high',
      subject: { kind: 'agent_domain', id: `${agentId}:${domain}` }, evidenceRefs: signals.filter((s) => s.level && s.level !== 'none').map((s) => s.id),
      metrics: { recommendation, attribution: result.attribution }, recordedBy: actorOf(options.recordedBy)
    });
  }
  return result;
}

module.exports = { detectDrift, snapshotWindow, populationStabilityIndex, differenceInterval, DRIFT_RECOMMENDATIONS: RECOMMENDATIONS };
