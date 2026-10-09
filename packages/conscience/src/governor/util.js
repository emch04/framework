'use strict';
/*
 * Plain helpers of the governor. This folder imports Node built-ins and its own
 * files only: no language model, no AI package, nothing that could make a
 * governance decision depend on generated text. A test walks the import graph.
 */
const crypto = require('node:crypto');

class GovernorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GovernorError';
    this.code = code;
  }
}

/** JSON with sorted keys, so equal values always give the same text. */
function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const fingerprintOf = (value) => sha256(canonical(value));
const copy = (value) => (value == null ? null : JSON.parse(JSON.stringify(value)));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/;

function prefixOf(options = {}, fallback) {
  const name = options.prefix ?? fallback;
  if (typeof name !== 'string' || !SQL_IDENTIFIER.test(name)) throw new Error('prefix must be a plain SQL identifier of at most 41 characters.');
  return name;
}

function requireQueryable(db) {
  if (!db || typeof db.query !== 'function') throw new Error('A database with query(sql, params) is required.');
  return db;
}

module.exports = { GovernorError, canonical, sha256, fingerprintOf, copy, deepFreeze, isNonEmptyString, prefixOf, requireQueryable };
