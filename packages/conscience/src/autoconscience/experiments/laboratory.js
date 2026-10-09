'use strict';
const { ready, fail, data, casesOf, metricsOf, statisticsOptions, timeoutOf, agentSource, invalid, date, fingerprintOf, deepFreeze } = require('./common');
const { number } = require('../statistics');
const { createSandbox, sandboxState, configurations } = require('./sandbox');
const { evaluateCases, reserveHoldout } = require('./holdout');
const { randomUUID } = require('node:crypto');
const registrations = new WeakMap();
const idsByGovernor = new WeakMap();
function protocolOf(input) {
  if (!input || typeof input !== 'object') invalid('protocol is required.');
  const protocol = data(input);
  protocol.development = casesOf(protocol.development, 'development');
  protocol.validation = casesOf(protocol.validation, 'validation');
  const ids = [...protocol.development, ...protocol.validation].map((c) => c.id);
  if (new Set(ids).size !== ids.length) invalid('Development and validation case ids must be disjoint.');
  return { ...protocol, ...statisticsOptions(protocol), timeoutMs: timeoutOf(protocol.timeoutMs) };
}
async function finding(binding, id, code, metrics) {
  await ready(binding);
  return binding.governor.recordFinding({ organisationId: binding.organisationId, id: `${id}:${code}`, code, severity: 'info',
    subject: { kind: 'experiment', id }, recordedBy: { kind: 'system', id: 'experiment-laboratory' }, metrics });
}
async function proposeExperiment(options = {}) {
  await ready(options);
  const binding = { governor: options.governor, organisationId: options.organisationId };
  if (typeof options.hypothesis !== 'string' || !options.hypothesis.trim()) invalid('hypothesis is required.');
  if (!options.metrics) invalid('metrics must be preregistered.');
  const metrics = metricsOf(options.metrics), protocol = protocolOf(options.protocol), thresholds = data(options.thresholds);
  if (!thresholds || Array.isArray(thresholds) || typeof thresholds !== 'object') invalid('thresholds must map metric names to numbers.');
  if (Object.keys(thresholds).length !== metrics.length) invalid('Every metric requires exactly one preregistered threshold.');
  for (const metric of metrics) number(thresholds[metric.name], `thresholds.${metric.name}`, 0, 1);
  const source = agentSource(options.agent), config = configurations(options.tools);
  const registeredAt = date((options.now ?? Date.now)(), 'registeredAt');
  const content = { organisationId: binding.organisationId, hypothesis: options.hypothesis, metrics, protocol, thresholds,
    candidateFingerprint: fingerprintOf(source), toolsFingerprint: fingerprintOf(config), registrationId: randomUUID(), registeredAt };
  const fingerprint = fingerprintOf(content), id = options.id ?? `experiment_${fingerprint.slice(0, 24)}`;
  if (typeof id !== 'string' || !id.trim()) invalid('Experiment id must be a non-empty string.');
  const ids = idsByGovernor.get(binding.governor) ?? new Set();
  idsByGovernor.set(binding.governor, ids);
  const scopedId = JSON.stringify([binding.organisationId, id]);
  if (ids.has(scopedId)) fail('experiment_conflict', 'An experiment already uses this id.');
  ids.add(scopedId);
  const token = Object.freeze({});
  let final;
  try {
    final = await reserveHoldout(options.holdout, binding, token, protocol.development, protocol.validation);
    const recorded = await finding(binding, id, 'experiment_registered', { fingerprint, registeredAt, candidateFingerprint: content.candidateFingerprint,
      metrics, thresholds, protocolFingerprint: fingerprintOf(protocol) });
    if (recorded.metrics?.fingerprint !== fingerprint) fail('experiment_conflict', 'Stored registration already uses this id.');
  } catch (error) { final?.release(); ids.delete(scopedId); throw error; }
  const experiment = deepFreeze({ id, ...content, fingerprint, sandbox: true });
  registrations.set(experiment, { ...binding, final, config, used: false, contentFingerprint: fingerprint, source });
  return experiment;
}
function conclusion(stages, metrics, thresholds) {
  const all = Object.values(stages).flatMap((stage) => metrics.map((metric) => ({ stats: stage.metrics[metric.name], threshold: thresholds[metric.name] })));
  if (all.some(({ stats }) => stats.status === 'insufficient_data' || stats.unknown > 0)) return 'inconclusive';
  if (all.some(({ stats, threshold }) => stats.interval.high < threshold)) return 'refuted';
  return all.every(({ stats, threshold }) => stats.interval.low >= threshold) ? 'supported' : 'inconclusive';
}
async function runExperiment(options = {}) {
  await ready(options);
  const { experiment } = options;
  const state = registrations.get(experiment);
  if (!state) fail('protocol_changed', 'Use the original preregistered experiment handle.');
  if (state.governor !== options.governor) invalid('Experiment governor mismatch.');
  options.governor.assertSingleOrganisation(options.organisationId, state.organisationId);
  for (const key of ['protocol', 'metrics', 'thresholds', 'hypothesis']) {
    if (options[key] !== undefined && fingerprintOf(data(options[key])) !== fingerprintOf(experiment[key])) fail('protocol_changed', 'Preregistered experiment content cannot change.');
  }
  if (options.agent && agentSource(options.agent) !== state.source) fail('protocol_changed', 'The registered candidate cannot change.');
  if (options.tools && fingerprintOf(configurations(options.tools)) !== experiment.toolsFingerprint) fail('protocol_changed', 'Registered tools cannot change.');
  const content = { ...experiment };
  delete content.fingerprint; delete content.id; delete content.sandbox;
  if (fingerprintOf(content) !== state.contentFingerprint) fail('protocol_changed', 'Experiment fingerprint mismatch.');
  if (state.used) fail('experiment_consumed', 'An experiment can execute only once; preregister a new experiment and final set.');
  state.used = true;
  const { protocol, metrics, thresholds } = experiment;
  const sandbox = await createSandbox({ ...state, tools: state.config });
  const { config } = await sandboxState(sandbox, state);
  const input = { binding: state, source: state.source, metrics, config, statistics: statisticsOptions(protocol), timeoutMs: protocol.timeoutMs };
  await finding(state, experiment.id, 'experiment_started', { fingerprint: experiment.fingerprint });
  try {
    const development = await evaluateCases({ ...input, cases: protocol.development, protectedSet: false });
    const validation = await evaluateCases({ ...input, cases: protocol.validation, protectedSet: false });
    const holdout = await state.final.evaluate(input);
    const stages = { development, validation, holdout };
    const result = { experimentId: experiment.id, fingerprint: experiment.fingerprint, registeredAt: experiment.registeredAt,
      sandbox: true, decision: conclusion(stages, metrics, thresholds), causality: 'not_established',
      interval: holdout.metrics[metrics[0].name].interval, stages };
    await finding(state, experiment.id, 'experiment_completed', result);
    return result;
  } catch (error) {
    // Keep errors out of the public evidence: a candidate message can contain protected inputs.
    await finding(state, experiment.id, 'experiment_failed', { fingerprint: experiment.fingerprint, code: 'execution_failed' });
    throw error;
  }
}
module.exports = { proposeExperiment, runExperiment };
