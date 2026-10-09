'use strict';
// Modèle commun des retours : constantes, validation stricte, nettoyage des données personnelles.

const RATINGS = Object.freeze(['up', 'down']);
const FEEDBACK_REASONS = Object.freeze(['inaccurate', 'incomplete', 'off_topic', 'wrong_source', 'too_long', 'unsafe', 'other']);
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const TAG_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

class FeedbackError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'FeedbackError';
    this.code = code;
    this.status = status ?? (code === 'not_found' ? 404 : code === 'unauthorized' ? 401 : 400);
  }
}
const invalid = (message) => new FeedbackError('invalid', message);

function resolveReasons(extra = []) {
  if (!Array.isArray(extra)) throw new Error('reasons must be an array.');
  for (const reason of extra) if (typeof reason !== 'string' || !REASON_PATTERN.test(reason)) throw new Error(`Invalid reason name: ${String(reason)}.`);
  return Object.freeze([...new Set([...FEEDBACK_REASONS, ...extra])]);
}

function identifier(value, name, { optional = false, max = 200 } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw invalid(`${name} is required.`);
  }
  if (typeof value !== 'string') throw invalid(`${name} must be a string.`);
  const text = value.trim();
  if (!text || text.length > max || CONTROL.test(text) || /[\n\r\t]/.test(text)) throw invalid(`${name} must be 1 to ${max} printable characters.`);
  return text;
}

function tag(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !TAG_PATTERN.test(value)) throw invalid(`${name} must match ${TAG_PATTERN}.`);
  return value;
}

function commentOf(value, maxComment) {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalid('comment must be a string.');
  if (CONTROL.test(value)) throw invalid('comment contains control characters.');
  const text = value.trim();
  if (text.length > maxComment) throw invalid(`comment is limited to ${maxComment} characters.`);
  return text || null;
}

/** Checks one feedback; returns the normalized fields (never partial). */
function normalizeFeedback(input, { reasons, maxComment }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Feedback must be an object.');
  if (!RATINGS.includes(input.rating)) throw invalid("rating must be 'up' or 'down'.");
  let reason = input.reason ?? null;
  if (reason !== null) {
    if (input.rating !== 'down') throw invalid("reason is only allowed with rating 'down'.");
    if (typeof reason !== 'string' || !reasons.includes(reason)) throw invalid('Unknown reason.');
  }
  return {
    tenantId: identifier(input.tenantId, 'tenantId', { optional: true }),
    userId: identifier(input.userId, 'userId'),
    runId: identifier(input.runId, 'runId'),
    messageId: identifier(input.messageId, 'messageId', { optional: true }),
    rating: input.rating,
    reason,
    comment: commentOf(input.comment, maxComment),
    agent: tag(input.agent, 'agent'),
    mode: tag(input.mode, 'mode')
  };
}

function keyOf(input) {
  return { tenantId: identifier(input?.tenantId, 'tenantId', { optional: true }), userId: identifier(input?.userId, 'userId'), runId: identifier(input?.runId, 'runId') };
}

/** Removes what identifies a person even if the injected masker missed it. */
function scrubPersonalData(text, { userId, tenantId } = {}) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const secret of [userId, tenantId]) if (typeof secret === 'string' && secret.length >= 3) out = out.split(secret).join('[user]');
  return out
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/(?:\+|\b)\d[\d\s().-]{6,}\d/g, '[number]');
}

function boundText(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const blank = cut.search(/\s\S*$/);
  return `${(blank > 0 ? cut.slice(0, blank) : cut).trimEnd()}…`;
}

module.exports = { RATINGS, FEEDBACK_REASONS, FeedbackError, resolveReasons, normalizeFeedback, keyOf, identifier, scrubPersonalData, boundText };
