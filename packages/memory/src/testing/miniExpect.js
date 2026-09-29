/**
 * The few matchers the store contract uses, for a test runner that has no
 * `expect` of its own (node:test): toBe, toEqual, toBeNull, toMatchObject,
 * toBeGreaterThanOrEqual, toContain, `.not`, and expect.arrayContaining.
 * Jest and Vitest bring their own and are used first.
 */
const { inspect } = require('util');

const ASYMMETRIC = Symbol('asymmetric matcher');

function arrayContaining(items) {
  return { [ASYMMETRIC]: true, match: (actual) => Array.isArray(actual) && items.every((item) => actual.some((value) => equals(value, item))) };
}

const isPlain = (value) => value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value);
const definedKeys = (value) => Object.keys(value).filter((key) => value[key] !== undefined);

/* Deep equality; a property that is undefined counts as missing, as in Jest's toEqual. */
function equals(actual, expected) {
  if (expected && expected[ASYMMETRIC]) return expected.match(actual);
  if (actual instanceof Date || expected instanceof Date) {
    return actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime();
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && actual.every((value, index) => equals(value, expected[index]));
  }
  if (isPlain(actual) && isPlain(expected)) {
    const keys = definedKeys(expected);
    return definedKeys(actual).length === keys.length && keys.every((key) => equals(actual[key], expected[key]));
  }
  return Object.is(actual, expected);
}

/* Every property of `expected` is found, recursively, in `actual`. */
function contains(actual, expected) {
  if (expected && expected[ASYMMETRIC]) return expected.match(actual);
  if (isPlain(expected)) return isPlain(actual) && Object.keys(expected).every((key) => contains(actual[key], expected[key]));
  return equals(actual, expected);
}

function matchers(actual, negate) {
  const check = (pass, what, expected) => {
    if (pass === negate) {
      throw new Error(`expected ${inspect(actual, { depth: 4 })} ${negate ? 'not ' : ''}${what}${expected === undefined ? '' : ` ${inspect(expected, { depth: 4 })}`}`);
    }
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), 'to be', expected),
    toEqual: (expected) => check(equals(actual, expected), 'to equal', expected),
    toBeNull: () => check(actual === null, 'to be null'),
    toMatchObject: (expected) => check(contains(actual, expected), 'to match', expected),
    toBeGreaterThanOrEqual: (expected) => check(actual >= expected, 'to be at least', expected),
    toContain: (expected) => check(Array.isArray(actual) || typeof actual === 'string' ? actual.includes(expected) : false, 'to contain', expected)
  };
}

function miniExpect(actual) {
  return { ...matchers(actual, false), not: matchers(actual, true) };
}
miniExpect.arrayContaining = arrayContaining;

module.exports = { miniExpect };
