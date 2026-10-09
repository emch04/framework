'use strict';
const { ConscienceError } = require('../errors');
const invalid = (message) => { throw new ConscienceError('invalid_input', message); };
function number(value, name, min = 0, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${name} must be finite in [${min}, ${max}].`);
  return value;
}
function minimum(value = 30) {
  number(value, 'minimumSample', 1);
  if (!Number.isInteger(value)) invalid('minimumSample must be an integer.');
  return value;
}
const Z = new Map([[0.9, 1.6448536269514722], [0.95, 1.959963984540054], [0.99, 2.5758293035489004]]);
/** Two-sided Wilson score interval, including the zero/all-success boundaries. */
function wilsonInterval(successes, total, level = 0.95) {
  if (!Number.isInteger(total) || !Number.isInteger(successes) || total < 0 || successes < 0 || successes > total) invalid('Invalid binomial counts.');
  if (!Z.has(level)) invalid('level must be 0.9, 0.95 or 0.99.');
  if (!total) return null;
  const z = Z.get(level), z2 = z * z, p = successes / total, denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return { low: Math.max(0, centre - radius), high: Math.min(1, centre + radius), level };
}
function honestStatistics(statuses, options = {}) {
  const threshold = minimum(options.minimumSample);
  const counts = { succeeded: 0, failed: 0, unknown: 0 };
  for (const status of statuses) {
    if (!Object.hasOwn(counts, status)) invalid('Invalid outcome status.');
    counts[status] += 1;
  }
  const sampleSize = counts.succeeded + counts.failed;
  const interval = wilsonInterval(counts.succeeded, sampleSize, options.level ?? 0.95);
  const sufficient = sampleSize >= threshold;
  return { ...counts, sampleSize, minimumSample: threshold, rate: sampleSize ? counts.succeeded / sampleSize : null,
    interval, status: sufficient ? 'observed' : 'insufficient_data', conclusion: sufficient ? 'descriptive_only' : 'refuse_to_conclude' };
}
/** One point per independent decision; callers must not duplicate revisions. */
function calibratePredictions(points, options = {}) {
  const threshold = minimum(options.minimumSample), bucketCount = options.buckets ?? 10;
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > 100) invalid('buckets must be an integer in [1, 100].');
  const groups = new Map();
  for (const point of points) {
    number(point.probability, 'probability', 0, 1);
    if (!['succeeded', 'failed', 'unknown'].includes(point.status)) invalid('Invalid outcome status.');
    const key = JSON.stringify([point.agentId, point.domain]);
    if (!groups.has(key)) groups.set(key, { agentId: point.agentId, domain: point.domain, points: new Map() });
    const group = groups.get(key);
    if (group.points.has(point.decisionId)) invalid('Duplicate decision in calibration group.');
    group.points.set(point.decisionId, point);
  }
  return [...groups.values()].map((group) => {
    const all = [...group.points.values()], known = all.filter((p) => p.status !== 'unknown');
    const statistics = honestStatistics(all.map((p) => p.status), { ...options, minimumSample: threshold });
    const bins = Array.from({ length: bucketCount }, (_, i) => ({ bucket: { low: i / bucketCount, high: (i + 1) / bucketCount }, points: [] }));
    for (const p of known) bins[Math.min(bucketCount - 1, Math.floor(p.probability * bucketCount))].points.push(p);
    const mean = (items, fn) => items.length ? items.reduce((sum, p) => sum + fn(p), 0) / items.length : null;
    const gap = mean(known, (p) => p.probability - Number(p.status === 'succeeded'));
    return { agentId: group.agentId, domain: group.domain, ...statistics,
      brierScore: mean(known, (p) => (p.probability - Number(p.status === 'succeeded')) ** 2),
      confidenceGap: gap, overconfidence: gap == null ? null : Math.max(0, gap), underconfidence: gap == null ? null : Math.max(0, -gap),
      curve: bins.map(({ bucket, points: list }) => ({ bucket, count: list.length, predicted: mean(list, (p) => p.probability),
        observed: mean(list, (p) => Number(p.status === 'succeeded')), interval: wilsonInterval(list.filter((p) => p.status === 'succeeded').length, list.length, options.level ?? 0.95),
        status: list.length >= threshold ? 'observed' : 'insufficient_data' })) };
  });
}
/** Thresholded binary prediction loss, divided by known decisions, in policy cost units. */
function scoreErrorCosts(points, policy, options = {}) {
  const falsePositive = number(policy.falsePositive, 'falsePositive'), falseNegative = number(policy.falseNegative, 'falseNegative');
  const threshold = number(options.decisionThreshold ?? 0.5, 'decisionThreshold', 0, 1);
  let fp = 0, fn = 0, known = 0, unknown = 0;
  for (const p of points) {
    number(p.probability, 'probability', 0, 1);
    if (p.domain !== policy.domain) invalid('Error cost policy domain mismatch.');
    if (p.status === 'unknown') { unknown += 1; continue; }
    if (!['succeeded', 'failed'].includes(p.status)) invalid('Invalid outcome status.');
    known += 1;
    if (p.probability >= threshold && p.status === 'failed') fp += 1;
    if (p.probability < threshold && p.status === 'succeeded') fn += 1;
  }
  const totalCost = fp * falsePositive + fn * falseNegative;
  return { falsePositives: fp, falseNegatives: fn, sampleSize: known, unknown, totalCost, weightedScore: known ? totalCost / known : null,
    status: known >= minimum(options.minimumSample) ? 'observed' : 'insufficient_data' };
}
module.exports = { wilsonInterval, honestStatistics, calibratePredictions, scoreErrorCosts, number, minimum, invalid };
