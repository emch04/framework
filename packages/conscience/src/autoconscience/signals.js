'use strict';
const { number, minimum, invalid, honestStatistics } = require('./statistics');
const CLASSES = ['factual', 'style', 'objective', 'disagreement'];
/** Application class has priority. Ambiguous or absent structured tags abstain to disagreement. */
function classifyCorrection(input) {
  if (input.class != null) {
    if (!CLASSES.includes(input.class)) invalid('Invalid correction class.');
    return input.class;
  }
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) invalid('Correction tags must be strings.');
  const mapped = new Set(tags.map((t) => ({ fact_changed: 'factual', wording_changed: 'style', goal_changed: 'objective', opinion_changed: 'disagreement' })[t]).filter(Boolean));
  return mapped.size === 1 ? [...mapped][0] : 'disagreement';
}
const DEFAULT_CLAIM_RULES = Object.freeze({ source_verified: ['source_verified'] });
/** Successful trace labels are attestations supplied by the instrumented application, never inferred from prose. */
function checkReasoningFidelity(justification = {}, traces = [], rules = DEFAULT_CLAIM_RULES) {
  const claims = justification.claims ?? [];
  if (!Array.isArray(claims) || !claims.every((c) => typeof c === 'string')) invalid('claims must be strings.');
  const unsupported = [], uncheckable = [];
  for (const claim of claims) {
    const required = Object.hasOwn(rules, claim) ? rules[claim] : null;
    if (required != null && (!Array.isArray(required) || !required.every((label) => typeof label === 'string'))) invalid('Claim rules must map to string arrays.');
    if (!required?.length) { uncheckable.push(claim); continue; }
    if (!required.every((label) => traces.some((t) => t.status === 'succeeded' && !t.empty && (t.labels ?? []).includes(label)))) unsupported.push(claim);
  }
  return { status: unsupported.length ? 'unfaithful' : uncheckable.length || !claims.length ? 'unknown' : 'faithful', unsupported, uncheckable };
}
function toolReliability(traces, options = {}) {
  const slowMs = number(options.slowMs ?? 5000, 'slowMs');
  const groups = new Map();
  for (const t of traces) {
    if (!t.tool || !['succeeded', 'failed', 'unknown'].includes(t.status)) invalid('Invalid tool trace.');
    number(t.durationMs, 'durationMs');
    const key = JSON.stringify([t.tool, t.provider ?? null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()].map((list) => {
    const calls = list.length, failures = list.filter((t) => t.status === 'failed').length;
    const unknownCalls = list.filter((t) => t.status === 'unknown').length, knownCalls = calls - unknownCalls;
    const emptyResults = list.filter((t) => t.empty === true).length, slowCalls = list.filter((t) => t.durationMs > slowMs).length;
    const latencies = list.map((t) => t.durationMs).sort((a, b) => a - b);
    const rate = (count) => ({ rate: count / calls, ...honestStatistics(Array.from({ length: calls }, (_, i) => i < count ? 'succeeded' : 'failed'), options) });
    const errorStatistics = honestStatistics(list.map((t) => t.status === 'unknown' ? 'unknown' : t.status === 'failed' ? 'succeeded' : 'failed'), options);
    return { tool: list[0].tool, provider: list[0].provider ?? null, calls, knownCalls, unknownCalls, failures, emptyResults, slowCalls,
      errorRate: knownCalls ? failures / knownCalls : null, emptyRate: emptyResults / calls, slowRate: slowCalls / calls,
      errorStatistics, emptyStatistics: rate(emptyResults), slowStatistics: rate(slowCalls), latencyP95Ms: latencies[Math.ceil(calls * 0.95) - 1] };
  });
}
function calendarConfounders(domain, at, calendars = []) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) invalid('Calendar observation date is invalid.');
  const matches = [];
  for (const calendar of calendars) {
    for (const period of calendar.periods) {
      const from = Date.parse(period.from), to = Date.parse(period.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) invalid('Invalid calendar period.');
      if (calendar.domain === domain && from <= time && time < to) matches.push({ calendar: calendar.name, label: period.label, from: period.from, to: period.to });
    }
  }
  return { status: matches.length ? 'calendar_confounded' : 'not_confounded', periods: matches };
}
function checkCounterMetrics(target, counters) {
  const direction = (d) => { if (!['higher_is_better', 'lower_is_better'].includes(d)) invalid('Invalid metric direction.'); return d === 'higher_is_better' ? 1 : -1; };
  const delta = (m) => (number(m.after, 'after', -Infinity) - number(m.before, 'before', -Infinity)) * direction(m.direction);
  const improvement = delta(target);
  const measures = counters.map((c) => ({ name: c.name, regression: Math.max(0, -delta(c)), maxRegression: number(c.maxRegression, 'maxRegression') }));
  const violations = measures.filter((c) => c.regression > c.maxRegression);
  return { status: improvement <= 0 ? 'no_improvement' : violations.length ? 'rejected' : 'accepted', improvement, measures, violations };
}
function reflectionUtility(run, options = {}) {
  const usefulFindings = number(run.usefulFindings ?? 0, 'usefulFindings'), acceptedProposals = number(run.acceptedProposals ?? 0, 'acceptedProposals');
  if (!Number.isInteger(usefulFindings) || !Number.isInteger(acceptedProposals)) invalid('Cycle counts must be integers.');
  const cost = number(run.cost ?? 0, 'cost');
  if (run.usefulFindings == null && run.acceptedProposals == null) return { usefulFindings, acceptedProposals, cost, benefit: null, utility: null, useful: null, status: 'unmeasured' };
  const benefit = usefulFindings * number(options.findingWeight ?? 1, 'findingWeight') + acceptedProposals * number(options.proposalWeight ?? 1, 'proposalWeight');
  const utility = benefit - cost * number(options.costWeight ?? 1, 'costWeight');
  return { usefulFindings, acceptedProposals, cost, benefit, utility, useful: benefit > 0 && utility > 0 };
}
function recommendReflectionFrequency(runs, options = {}) {
  const count = minimum(options.uselessCycles ?? 3), factor = number(options.reductionFactor ?? 2, 'reductionFactor', 1);
  const sorted = [...runs].filter((r) => r.status === 'completed').sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)) || a.id.localeCompare(b.id));
  let uselessStreak = 0;
  for (let i = sorted.length - 1; i >= 0 && reflectionUtility(sorted[i], options).useful === false; i -= 1) uselessStreak += 1;
  return { recommendation: uselessStreak >= count ? 'reduce' : 'maintain', uselessStreak, intervalMultiplier: uselessStreak >= count ? factor : 1 };
}
module.exports = { classifyCorrection, checkReasoningFidelity, toolReliability, calendarConfounders, checkCounterMetrics, reflectionUtility, recommendReflectionFrequency, DEFAULT_CLAIM_RULES };
