'use strict';
/* global AbortSignal */

const fs = require('node:fs/promises');

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(value), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function bucket(seed, identifier) {
  if (identifier === undefined || identifier === null || String(identifier) === '') return null;
  return fnv1a32(`${seed}\u0000${identifier}`) / 0x100000000;
}

function normalizeRules(input) {
  const rules = typeof input === 'string' ? JSON.parse(input) : input;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || !rules.flags || typeof rules.flags !== 'object' || Array.isArray(rules.flags)) {
    throw new TypeError('La configuration doit contenir un objet « flags ».');
  }
  return Object.freeze({ ...rules, flags: Object.freeze({ ...rules.flags }) });
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) return null;
  const withoutBuild = value.split('+', 1)[0];
  const [core, prerelease] = withoutBuild.split('-', 2);
  const parts = core.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  while (parts.length < 3) parts.push(0);
  return { parts, prerelease: prerelease === undefined ? null : prerelease.split('.') };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  const length = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < length; i++) {
    const difference = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < count; i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Math.sign(Number(ai) - Number(bi));
    if (an !== bn) return an ? -1 : 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

function matchesVersion(rule, context) {
  const actual = context.attributes?.appVersion;
  if (typeof rule === 'string') return compareVersions(actual, rule) === 0;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  for (const [operator, expected] of Object.entries(rule)) {
    if (operator === 'between') {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const lower = compareVersions(actual, expected[0]);
      const upper = compareVersions(actual, expected[1]);
      if (lower === null || upper === null || lower < 0 || upper > 0) return false;
      continue;
    }
    const comparison = compareVersions(actual, expected);
    if (comparison === null) return false;
    if ((operator === 'gte' || operator === '>=') && comparison < 0) return false;
    if ((operator === 'gt' || operator === '>') && comparison <= 0) return false;
    if ((operator === 'lte' || operator === '<=') && comparison > 0) return false;
    if ((operator === 'lt' || operator === '<') && comparison >= 0) return false;
    if ((operator === 'eq' || operator === '==') && comparison !== 0) return false;
    if (!['gte', 'gt', 'lte', 'lt', 'eq', '>=', '>', '<=', '<', '==', 'between'].includes(operator)) return false;
  }
  return Object.keys(rule).length > 0;
}

function matchesNumber(rule, context) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.attribute !== 'string') return false;
  const actual = context.attributes?.[rule.attribute];
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  const operators = Object.entries(rule).filter(([key]) => key !== 'attribute');
  if (operators.length === 0) return false;
  for (const [operator, expected] of operators) {
    if ((operator === 'gt' || operator === '>') && !(actual > expected)) return false;
    if ((operator === 'gte' || operator === '>=') && !(actual >= expected)) return false;
    if ((operator === 'lt' || operator === '<') && !(actual < expected)) return false;
    if ((operator === 'lte' || operator === '<=') && !(actual <= expected)) return false;
    if (operator === 'between' && (!Array.isArray(expected) || expected.length !== 2 || !expected.every(Number.isFinite) || actual < expected[0] || actual > expected[1])) return false;
    if (!['gt', 'gte', 'lt', 'lte', '>', '>=', '<', '<=', 'between'].includes(operator) || (operator !== 'between' && (typeof expected !== 'number' || !Number.isFinite(expected)))) return false;
  }
  return true;
}

function matchesTarget(target, context) {
  if (!target) return true;
  if (Object.hasOwn(target, 'all')) return Array.isArray(target.all) && target.all.every((rule) => matchesTarget(rule, context));
  if (Object.hasOwn(target, 'any')) return Array.isArray(target.any) && target.any.some((rule) => matchesTarget(rule, context));
  if (Object.hasOwn(target, 'version')) return matchesVersion(target.version, context);
  if (Object.hasOwn(target, 'number')) return matchesNumber(target.number, context);
  for (const [key, expected] of Object.entries(target)) {
    const actual = context.attributes?.[key] ?? (key === 'userId' ? context.targetingKey : undefined);
    if (Array.isArray(expected) ? !expected.includes(actual) : actual !== expected) return false;
  }
  return true;
}

function resolve(config, key, context, type) {
  const flag = config.flags[key];
  if (!flag) return { value: type === 'boolean' ? false : undefined, reason: 'FLAG_NOT_FOUND', variant: undefined, flagKey: key };
  if (flag.type !== type) return { value: flag.default, reason: 'ERROR', variant: undefined, flagKey: key };
  if (!matchesTarget(flag.target, context)) return { value: flag.default, reason: 'TARGETING_MISMATCH', variant: undefined, flagKey: key };
  const identity = context.targetingKey;
  if (flag.rollout !== undefined) {
    const percentage = Number(flag.rollout);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return { value: flag.default, reason: 'ERROR', flagKey: key };
    const fraction = bucket(flag.seed ?? key, identity);
    if (fraction === null || fraction >= percentage / 100) return { value: flag.default, reason: 'DEFAULT', flagKey: key };
  }
  if (Array.isArray(flag.variants) && flag.variants.length) {
    const namespace = flag.namespace || key;
    const fraction = bucket(namespace, identity);
    if (fraction === null) return { value: flag.default, reason: 'DEFAULT', flagKey: key };
    let cursor = 0;
    for (const variant of flag.variants) {
      const weight = Number(variant.weight);
      if (!Number.isFinite(weight) || weight < 0) return { value: flag.default, reason: 'ERROR', flagKey: key };
      cursor += weight / 100;
      if (fraction < cursor) return { value: variant.value, reason: 'TARGETING_MATCH', variant: variant.name, flagKey: key };
    }
    return { value: flag.default, reason: 'DEFAULT', flagKey: key };
  }
  return { value: flag.value, reason: flag.rollout !== undefined ? 'SPLIT' : 'STATIC', flagKey: key };
}

function createMemorySource(initial) {
  let current = normalizeRules(initial);
  return { async get() { return current; }, async set(next) { current = normalizeRules(next); return current; } };
}

function createFileSource(path) {
  return { async get() { return normalizeRules(await fs.readFile(path, 'utf8')); } };
}

function createUrlSource(url, options = {}) {
  const interval = options.refreshIntervalMs ?? 30_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch indisponible; fournissez options.fetch.');
  let current = options.initial ? normalizeRules(options.initial) : null;
  let timer = null;
  let refreshing = null;
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = normalizeRules(await response.json());
        current = next;
        return next;
      } catch (error) {
        if (current) return current;
        throw error;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  return {
    async get() { if (!current) return refresh(); return current; },
    refresh() { return refresh(); },
    start() { if (!timer && interval > 0) { timer = setInterval(() => { refresh().catch(() => {}); }, interval); timer.unref?.(); } return this; },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}

function createFlagProvider(options) {
  if (!options || !options.source || typeof options.source.get !== 'function') throw new TypeError('Une source avec get() est requise.');
  const onExposure = options.onExposure;
  async function evaluate(type, key, defaultValue, context = {}) {
    let detail;
    try {
      const config = await options.source.get();
      detail = resolve(config, key, context, type);
      if (detail.value === undefined) detail.value = defaultValue;
    } catch {
      detail = { value: defaultValue, reason: 'ERROR', flagKey: key };
    }
    if (detail.reason === 'TARGETING_MATCH' && detail.variant && typeof onExposure === 'function') {
      try { await onExposure({ flagKey: key, variant: detail.variant, targetingKey: context.targetingKey, context }); } catch { /* Une télémétrie défaillante ne bloque pas l'évaluation. */ }
    }
    return { ...detail, value: detail.value ?? defaultValue };
  }
  return {
    metadata: { name: options.name ?? 'astratra-flags' },
    resolveBoolean: (key, fallback = false, context = {}) => evaluate('boolean', key, fallback, context),
    resolveString: (key, fallback = '', context = {}) => evaluate('string', key, fallback, context),
    resolveNumber: (key, fallback = 0, context = {}) => evaluate('number', key, fallback, context),
    resolveObject: (key, fallback = {}, context = {}) => evaluate('json', key, fallback, context),
    async close() { await options.source.stop?.(); }
  };
}

module.exports = { fnv1a32, bucket, compareVersions, createMemorySource, createFileSource, createUrlSource, createFlagProvider };
