'use strict';
const { assertGovernorReady } = require('../../governor/governor');
const { ConscienceError } = require('../../errors');
const { fingerprintOf, deepFreeze } = require('../../governor/util');
const { invalid, minimum, number, honestStatistics } = require('../statistics');
const fail = (code, message) => { throw new ConscienceError(code, message); };
async function ready(options = {}) {
  await assertGovernorReady(options.governor, { organisationId: options.organisationId });
  options.governor.assertSingleOrganisation(options.organisationId);
  return options;
}
function date(value, label) {
  if (value == null || (!['string', 'number'].includes(typeof value) && !(value instanceof Date))) invalid(`${label} requires a date.`);
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) invalid(`${label} requires a date.`);
  return new Date(ms).toISOString();
}
/** Copy only data, without invoking accessors, toJSON or executable callbacks. */
function data(value, depth = 0, seen = new Set()) {
  if (depth > 32 || seen.has(value)) invalid('Data must be acyclic and at most 32 levels deep.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) invalid('Only plain JSON data is allowed.');
  seen.add(value);
  const out = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) invalid('Data accessors are forbidden.');
    out[key] = data(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  // Restore ordinary JSON objects, including safe own __proto__ properties.
  return JSON.parse(JSON.stringify(out));
}
function agentSource(agent) {
  if (typeof agent !== 'function') invalid('agent must be a self-contained function.');
  const source = Function.prototype.toString.call(agent);
  if (source.length > 100000 || source.includes('[native code]')) invalid('agent must be serializable source, without bound/native functions.');
  return source;
}
function casesOf(cases, label = 'cases') {
  const list = data(cases);
  if (!Array.isArray(list) || !list.length || list.length > 10000) invalid(`${label} needs 1 to 10000 cases.`);
  const ids = new Set();
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || !Object.hasOwn(item, 'input') || !Object.hasOwn(item, 'expected')) invalid('Every case needs id, input and expected.');
    if (ids.has(item.id)) invalid('Case ids must be distinct.');
    ids.add(item.id);
  }
  if (new Set(list.map((item) => fingerprintOf(item.input))).size !== list.length) invalid('Duplicate inputs cannot count as independent cases.');
  return list;
}
function metricsOf(metrics = [{ name: 'accuracy', kind: 'exact_match' }]) {
  const list = data(metrics);
  if (!Array.isArray(list) || !list.length || list.length > 20) invalid('metrics must be a non-empty list (at most 20).');
  const names = new Set();
  for (const metric of list) {
    if (!metric || typeof metric.name !== 'string' || !/^[a-z][a-z0-9_]{0,60}$/.test(metric.name) || metric.kind !== 'exact_match') invalid('Metrics require a name and kind: exact_match.');
    for (const key of ['outputKey', 'expectedKey']) if (metric[key] != null && (typeof metric[key] !== 'string' || !metric[key])) invalid('Metric keys must be non-empty strings.');
    if (names.has(metric.name)) invalid('Duplicate metric name.');
    names.add(metric.name);
  }
  return list;
}
function statisticsOptions(options = {}) {
  const minimumSample = minimum(options.minimumSample);
  const level = options.level ?? 0.95;
  honestStatistics([], { minimumSample, level });
  return { minimumSample, level };
}
function timeoutOf(value = 1000) {
  number(value, 'timeoutMs', 10, 30000);
  if (!Number.isInteger(value)) invalid('timeoutMs must be an integer.');
  return value;
}
module.exports = { ready, fail, date, data, agentSource, casesOf, metricsOf, statisticsOptions, timeoutOf, invalid, fingerprintOf, deepFreeze };
