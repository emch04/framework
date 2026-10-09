'use strict';
/*
 * Aggregation of ShadowRuns into an honest report (proposition 21). Pure and
 * deterministic: the same runs give the same report. It reuses the statistics
 * of P2 (Wilson intervals, minimum sample, "insufficient data") and the
 * anti-Goodhart check of P2 (target against counter-measures). The conclusion is
 * one of four codes and never says "proven": a shadow comparison on a sample of
 * real requests can only make an improvement promising, never established.
 */
const { honestStatistics, wilsonInterval } = require('../statistics');
const { checkCounterMetrics } = require('../signals');
const { differenceInterval } = require('../vigilance/drift');

const CONCLUSIONS = Object.freeze(['insufficient_data', 'regression', 'no_difference', 'promising']);
const round = (value) => (value == null ? null : Math.round(value * 1e6) / 1e6);
const mean = (list) => (list.length ? list.reduce((sum, v) => sum + v, 0) / list.length : null);
const roundInterval = (i) => (i ? { low: round(i.low), high: round(i.high), level: i.level } : null);

function statsOf(statuses, options) {
  const s = honestStatistics(statuses, options);
  return { succeeded: s.succeeded, failed: s.failed, unknown: s.unknown, sampleSize: s.sampleSize, minimumSample: s.minimumSample,
    rate: round(s.rate), interval: roundInterval(s.interval), status: s.status, conclusion: s.conclusion };
}

function metricReport(metric, runs, options) {
  const cand = [], stable = [];
  const paired = { bothSucceeded: 0, onlyStableSucceeded: 0, onlyCandidateSucceeded: 0, bothFailed: 0, unknown: 0 };
  for (const run of runs) {
    const score = run.scores?.[metric.name] ?? { candidate: 'unknown', stable: 'unknown' };
    cand.push(score.candidate); stable.push(score.stable);
    if (score.candidate === 'unknown' || score.stable === 'unknown') paired.unknown += 1;
    else if (score.candidate === 'succeeded') paired[score.stable === 'succeeded' ? 'bothSucceeded' : 'onlyCandidateSucceeded'] += 1;
    else paired[score.stable === 'succeeded' ? 'onlyStableSucceeded' : 'bothFailed'] += 1;
  }
  const candidate = statsOf(cand, options), stableStats = statsOf(stable, options);
  const observed = candidate.status === 'observed' && stableStats.status === 'observed';
  // Difference of two proportions (candidate minus stable), Newcombe hybrid score interval built on the Wilson intervals of P2.
  const difference = observed ? differenceInterval(stableStats.succeeded, stableStats.sampleSize, candidate.succeeded, candidate.sampleSize, options.level) : null;
  return { name: metric.name, critical: metric.critical === true, candidate, stable: stableStats, paired, status: observed ? 'observed' : 'insufficient_data',
    difference: difference && { difference: round(difference.difference), low: round(difference.low), high: round(difference.high), level: difference.level } };
}

function buildReport({ runs, metrics, target, options, limits = {} }) {
  const stats = { minimumSample: options.minimumSample, level: options.level };
  const reasons = [];
  const perMetric = Object.fromEntries(metrics.map((metric) => [metric.name, metricReport(metric, runs, stats)]));

  const criticalRegressions = [];
  for (const run of runs) {
    for (const metric of metrics) {
      const score = run.scores?.[metric.name];
      if (metric.critical === true && score?.stable === 'succeeded' && score.candidate === 'failed') {
        criticalRegressions.push({ runId: run.id, metric: metric.name, createdAt: run.createdAt, request: run.request,
          candidateOutput: run.candidate?.output ?? null, stableOutput: run.stable?.output ?? null, incidents: [...(run.incidents ?? [])] });
      }
    }
  }

  const withIncident = runs.filter((run) => (run.incidents ?? []).length > 0);
  const incidentInterval = wilsonInterval(withIncident.length, runs.length, options.level);
  const byCode = {};
  for (const run of runs) for (const code of new Set(run.incidents ?? [])) byCode[code] = (byCode[code] ?? 0) + 1;
  const incidents = { runs: withIncident.length, rate: runs.length ? round(withIncident.length / runs.length) : null, interval: roundInterval(incidentInterval),
    byCode, status: runs.length >= options.minimumSample ? 'observed' : 'insufficient_data', maxRate: options.maxIncidentRate };

  const agree = statsOf(runs.map((run) => (run.agreement ? 'succeeded' : 'failed')), stats);
  const writes = { total: 0, runsWithWrites: 0, byTool: {}, neverExecuted: true };
  for (const run of runs) {
    const list = run.writeIntentions ?? [];
    writes.total += list.length; if (list.length) writes.runsWithWrites += 1;
    for (const w of list) writes.byTool[w.tool] = (writes.byTool[w.tool] ?? 0) + 1;
  }
  const costs = runs.map((run) => run.cost).filter((v) => typeof v === 'number');
  const stableCosts = runs.map((run) => run.stableCost).filter((v) => typeof v === 'number');
  const durations = runs.map((run) => run.durationMs).filter((v) => typeof v === 'number');
  const cost = { total: round(costs.reduce((a, b) => a + b, 0)), mean: round(mean(costs)), stableMean: stableCosts.length === runs.length ? round(mean(stableCosts)) : null };
  const duration = { mean: round(mean(durations)), max: durations.length ? Math.max(...durations) : null };

  // Anti-Goodhart (P2): the target improves only if no counter-measure got worse than its limit.
  const targetReport = perMetric[target];
  const counters = [];
  for (const metric of metrics) {
    if (metric.name === target) continue;
    const report = perMetric[metric.name];
    if (report.status !== 'observed') continue;
    counters.push({ name: metric.name, direction: 'higher_is_better', before: report.stable.rate, after: report.candidate.rate, maxRegression: metric.maxRegression });
  }
  let costCounterUnmeasured = false;
  if (limits.cost != null) {
    if (cost.stableMean == null || cost.mean == null) costCounterUnmeasured = true;
    else counters.push({ name: 'cost', direction: 'lower_is_better', before: cost.stableMean, after: cost.mean, maxRegression: limits.cost });
  }
  const observed = targetReport.status === 'observed';
  const antiGoodhart = observed ? { target, ...checkCounterMetrics({ name: target, direction: 'higher_is_better', before: targetReport.stable.rate, after: targetReport.candidate.rate }, counters),
    counterMeasures: counters.length } : null;

  const insufficient = runs.length < options.minimumSample || Object.values(perMetric).some((m) => m.status !== 'observed') || costCounterUnmeasured;
  let conclusion;
  if (criticalRegressions.length > options.maxCriticalRegressions) { conclusion = 'regression'; reasons.push('critical_regression'); }
  else if (insufficient) {
    conclusion = 'insufficient_data'; reasons.push('insufficient_data');
    if (runs.length < options.minimumSample) reasons.push('below_minimum_sample');
    for (const m of Object.values(perMetric)) if (m.status !== 'observed') reasons.push(`metric_insufficient:${m.name}`);
    if (costCounterUnmeasured) reasons.push('cost_unmeasured');
  } else {
    const declined = Object.values(perMetric).filter((m) => m.difference && m.difference.high < 0).map((m) => m.name);
    const unsafe = incidentInterval && incidentInterval.low > options.maxIncidentRate;
    if (declined.length) reasons.push(...declined.map((name) => `significant_decline:${name}`));
    if (unsafe) reasons.push('candidate_incidents');
    if (antiGoodhart.violations.length) reasons.push(...antiGoodhart.violations.map((v) => `counter_measure_regressed:${v.name}`));
    if (reasons.length) conclusion = 'regression';
    else if (targetReport.difference.low > 0 && antiGoodhart.status === 'accepted') { conclusion = 'promising'; reasons.push('target_improved_counter_measures_held'); }
    else { conclusion = 'no_difference'; reasons.push('no_significant_difference'); }
  }

  const times = runs.map((run) => run.createdAt).sort();
  return {
    conclusion, reasons,
    sample: { runs: runs.length, minimumSample: options.minimumSample, level: options.level, status: runs.length >= options.minimumSample ? 'observed' : 'insufficient_data',
      firstAt: times[0] ?? null, lastAt: times.at(-1) ?? null, sampleRates: [...new Set(runs.map((run) => run.sampleRate))].sort() },
    target, metrics: perMetric, antiGoodhart, criticalRegressions, incidents, agreement: agree, writeIntentions: writes, cost, durationMs: duration
  };
}

module.exports = { buildReport, CONCLUSIONS };
