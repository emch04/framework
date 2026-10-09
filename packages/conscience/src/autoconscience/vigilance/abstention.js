'use strict';
/*
 * Abstention policy (proposition 26). Below a confidence threshold the agent
 * should ask for a precision or propose a check instead of acting.
 *
 * The threshold comes from two P2 inputs:
 *   - the calibration curve (announced confidence against observed frequency);
 *   - the asymmetric error costs. Acting on a decision that fails costs
 *     `falsePositive`; abstaining on one that would have succeeded costs
 *     `falseNegative`. Acting is worth it when the chance of success is at
 *     least t* = falsePositive / (falsePositive + falseNegative).
 *
 * The threshold is the lowest announced confidence (with observations of its
 * own) from which, over every
 * decision announced at least that confident, the lower end of the Wilson
 * interval of the observed success rate stays at or above t*. The sample must
 * reach `minimumSample`. Not enough data (or no cost table): a prudent default
 * threshold, never lower than the one already in force. If no region is
 * reliable, the threshold is 1.
 *
 * A change of threshold is a proposal to the governor (target kind
 * "threshold"). It is never applied here: `effectiveThreshold` stays the one
 * in force until a human approves and the application serves the new version.
 */
const { wilsonInterval, minimum, number } = require('../statistics');
const { ready, invalid, actorOf } = require('./common');

const ASK = 'ask_clarification';
const VERIFY = 'propose_verification';
const DEFAULT_THRESHOLD = 0.8;
const round = (value) => Math.round(value * 1e6) / 1e6;

function pickCalibration(options) {
  if (options.calibration) return options.calibration;
  const found = (options.findings ?? []).find((f) => f.kind === 'calibration' && f.agentId === options.agentId && f.domain === options.domain);
  return found?.details ?? null;
}

function regions(curve) {
  const buckets = [...curve].sort((a, b) => a.bucket.low - b.bucket.low);
  const out = [];
  let n = 0, successes = 0;
  for (let i = buckets.length - 1; i >= 0; i -= 1) {
    n += buckets[i].count;
    successes += buckets[i].count && buckets[i].observed != null ? Math.round(buckets[i].count * buckets[i].observed) : 0;
    out.push({ from: buckets[i].bucket.low, n, successes, populated: buckets[i].count > 0 });
  }
  return out.reverse();
}

async function abstentionPolicy(options = {}) {
  const { governor, organisationId, agentId, domain } = options;
  await ready(governor, organisationId);
  if (typeof agentId !== 'string' || !agentId) invalid('agentId is required.');
  if (typeof domain !== 'string' || !domain) invalid('domain is required.');
  const threshold0 = number(options.defaultThreshold ?? DEFAULT_THRESHOLD, 'defaultThreshold', 0, 1);
  const current = options.currentThreshold == null ? null : number(options.currentThreshold, 'currentThreshold', 0, 1);
  const needed = minimum(options.minimumSample);
  const level = options.level ?? 0.95;
  wilsonInterval(0, 1, level);

  const calibration = pickCalibration(options);
  if (calibration && ((calibration.agentId != null && calibration.agentId !== agentId) || (calibration.domain != null && calibration.domain !== domain))) invalid('The calibration belongs to another agent or domain.');
  const costs = options.errorCosts ?? options.errorCostPolicy ?? null;
  let costRatio = null;
  if (costs) {
    const fp = number(costs.falsePositive, 'errorCosts.falsePositive'), fn = number(costs.falseNegative, 'errorCosts.falseNegative');
    if (fp + fn > 0) costRatio = fp / (fp + fn);
  }
  const effectiveThreshold = current ?? threshold0;

  const reasons = [];
  if (!calibration) reasons.push('no_calibration');
  else if (calibration.status !== 'observed' || (calibration.sampleSize ?? 0) < needed) reasons.push('insufficient_data');
  if (costRatio === null) reasons.push('no_error_costs');

  let threshold, basis, region = null;
  if (reasons.length) {
    basis = 'insufficient_data';
    threshold = Math.max(threshold0, current ?? 0);
  } else {
    const usable = regions(calibration.curve ?? []).filter((r) => r.populated && r.n >= needed && wilsonInterval(r.successes, r.n, level).low >= costRatio);
    if (usable.length) {
      const lowest = usable[0];
      threshold = lowest.from;
      basis = 'calibration_and_costs';
      region = { from: lowest.from, sampleSize: lowest.n, rate: round(lowest.successes / lowest.n), interval: wilsonInterval(lowest.successes, lowest.n, level) };
    } else {
      threshold = 1;
      basis = 'no_reliable_region';
      reasons.push('no_reliable_region');
    }
  }
  threshold = round(threshold);
  const changeRequired = Math.abs(threshold - effectiveThreshold) > 0.005;

  const policy = {
    organisationId, agentId, domain, threshold, effectiveThreshold, basis, status: basis === 'insufficient_data' ? 'prudent_default' : 'computed',
    costRatio: costRatio === null ? null : round(costRatio), sampleSize: calibration?.sampleSize ?? 0, minimumSample: needed, region, reasons,
    belowThreshold: { recommendation: ASK, alternative: VERIFY }, changeRequired, applied: false, proposal: null
  };
  if (changeRequired && options.propose) {
    const proposedBy = actorOf(options.propose.proposedBy, { kind: 'engine', id: 'abstention-policy' });
    policy.proposal = await governor.evaluatePolicy({
      organisationId, target: { kind: 'threshold', id: `abstention:${agentId}:${domain}` },
      change: { abstentionThreshold: threshold, previousThreshold: current, basis },
      justification: { code: 'abstention_policy', basis, sampleSize: policy.sampleSize, costRatio: policy.costRatio, region },
      risk: options.propose.risk ?? (threshold < effectiveThreshold ? 'high' : 'medium'), proposedBy, owner: options.propose.owner ?? null
    });
  }
  return policy;
}

/** What to do with one decision, given the threshold IN FORCE (never a pending proposal). */
function shouldAbstain(policy, { confidence, actionKind } = {}) {
  if (!policy || typeof policy.effectiveThreshold !== 'number') invalid('An abstention policy is required.');
  number(confidence, 'confidence', 0, 1);
  const abstain = confidence < policy.effectiveThreshold;
  const risky = actionKind === 'write' || actionKind === 'confirm';
  return { abstain, threshold: policy.effectiveThreshold, recommendation: abstain ? (risky ? VERIFY : ASK) : 'proceed' };
}

module.exports = { abstentionPolicy, shouldAbstain, ABSTENTION_DEFAULT_THRESHOLD: DEFAULT_THRESHOLD };
