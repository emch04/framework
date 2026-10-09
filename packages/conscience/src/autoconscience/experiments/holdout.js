'use strict';
const { ready, fail, data, casesOf, metricsOf, statisticsOptions, agentSource, timeoutOf, fingerprintOf, deepFreeze } = require('./common');
const { createSandbox, sandboxState } = require('./sandbox');
const { execute } = require('./execution');
const { honestStatistics } = require('../statistics');
const states = new WeakMap();
function score(output, expected, metric, completed) {
  if (!completed) return 'unknown';
  const field = (value, key) => !key ? value : value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
  const actual = field(output, metric.outputKey);
  const target = field(expected, metric.expectedKey);
  if (actual === undefined || target === undefined) return 'unknown';
  return fingerprintOf(actual) === fingerprintOf(target) ? 'succeeded' : 'failed';
}
/** Only aggregate binomial statistics leave this function for a protected set. */
async function evaluateCases({ binding, source, cases, metrics, config, statistics, timeoutMs, protectedSet = true }) {
  const statuses = Object.fromEntries(metrics.map((m) => [m.name, []]));
  const journal = [];
  for (const sample of cases) {
    const result = await execute({ ...binding, source, input: sample.input, config, timeoutMs });
    if (!protectedSet) journal.push(...(result.journal ?? []).map((entry) => ({ ...entry, caseId: sample.id })));
    for (const metric of metrics) statuses[metric.name].push(score(result.output, sample.expected, metric, result.status === 'completed'));
  }
  return { sandbox: true, ...(!protectedSet ? { journal } : {}), metrics: Object.fromEntries(metrics.map((m) => [m.name, honestStatistics(statuses[m.name], statistics)])) };
}
async function createHoldout(options = {}) {
  await ready(options);
  const binding = { governor: options.governor, organisationId: options.organisationId };
  const cases = deepFreeze(casesOf(options.cases));
  const access = [];
  const state = { ...binding, cases, used: false, reserved: null, inputHashes: new Set(cases.map((c) => fingerprintOf(c.input))) };
  const log = (action) => access.push({ sequence: access.length + 1, action, at: new Date().toISOString() });
  const deny = () => { log('read_denied'); return fail('holdout_protected', 'Holdout content is never readable.'); };
  async function evaluate(input = {}) {
    await ready(binding);
    if (input.organisationId != null) binding.governor.assertSingleOrganisation(binding.organisationId, input.organisationId);
    if (state.reserved) fail('holdout_protected', 'This final set is reserved for its registered experiment.');
    const source = agentSource(input.agent), metrics = metricsOf(input.metrics), statistics = statisticsOptions(input), timeoutMs = timeoutOf(input.timeoutMs);
    const sandbox = input.sandbox ?? await createSandbox({ ...binding, tools: input.tools });
    const { config } = await sandboxState(sandbox, binding);
    return consume(state, { source, metrics, statistics, timeoutMs, config }, log);
  }
  const target = Object.assign(Object.create(null), {
    evaluate, async getAccessLog() { await ready(binding); return data(access); },
    read: deny
  });
  Object.freeze(target);
  const protectedSet = new Proxy(target, {
    get: (object, key) => key === 'then' ? undefined : Object.hasOwn(object, key) ? object[key] : deny(),
    ownKeys: deny, set: deny, defineProperty: deny, deleteProperty: deny,
    getOwnPropertyDescriptor: (object, key) => Object.hasOwn(object, key) ? Object.getOwnPropertyDescriptor(object, key) : deny(),
    has: (object, key) => Object.hasOwn(object, key) ? true : deny()
  });
  state.log = log;
  states.set(protectedSet, state);
  return protectedSet;
}
async function consume(state, input, log = state.log) {
  await ready(state);
  if (state.used) { log('evaluation_denied'); fail('holdout_consumed', 'A final set can be evaluated only once.'); }
  state.used = true; log('evaluation_started');
  try {
    const result = await evaluateCases({ binding: state, cases: state.cases, ...input });
    log('evaluation_completed'); return result;
  } catch (error) { log('evaluation_failed'); throw error; }
}
async function reserveHoldout(holdout, binding, token, development, validation) {
  await ready(binding);
  const state = states.get(holdout);
  if (!state || state.governor !== binding.governor) fail('holdout_protected', 'Use a holdout created with this governor.');
  binding.governor.assertSingleOrganisation(binding.organisationId, state.organisationId);
  if (state.used || state.reserved) fail('holdout_consumed', 'Holdout already used or reserved.');
  const hashes = new Set();
  for (const sample of [...development, ...validation]) {
    const hash = fingerprintOf(sample.input);
    if (hashes.has(hash) || state.inputHashes.has(hash) || state.cases.some((c) => c.id === sample.id)) fail('split_overlap', 'Development, validation and holdout inputs must be disjoint.');
    hashes.add(hash);
  }
  state.reserved = token; state.log('reserved');
  return Object.freeze({ release() {
    if (!state.used && state.reserved === token) { state.reserved = null; state.log('registration_failed'); }
  }, async evaluate(input) {
    await ready(binding);
    if (state.reserved !== token) fail('holdout_protected', 'Invalid final evaluation capability.');
    return consume(state, input);
  } });
}
module.exports = { createHoldout, evaluateCases, reserveHoldout };
