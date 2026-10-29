'use strict';
const { GouvernanceError } = require('./errors');
const { OPERATIONS, NAME, isPlainObject } = require('./contract');

/*
 * Les niveaux d'autonomie. Une règle dit, pour un type d'action, ce que l'IA a le droit de
 * faire seule. La règle la plus stricte qui s'applique l'emporte ; une écriture qu'aucune règle
 * ne couvre attend une validation humaine.
 */

const LEVELS = Object.freeze(['free', 'free_with_notice', 'validation', 'forbidden']);
const DEFAULT_LEVEL = 'validation';
const rank = (level) => LEVELS.indexOf(level);
const stricter = (a, b) => (rank(a) >= rank(b) ? a : b);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const fail = (message) => { throw new GouvernanceError('invalid_rules', message); };

function names(value, label, id, pattern = NAME) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === 'string' && pattern.test(v))) fail(`${id} : ${label} doit être une liste de noms.`);
  return Object.freeze([...new Set(value)]);
}

function threshold(value, label, id) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${id} : ${label} doit être un nombre positif.`);
  return value;
}

function normalizeWhen(when, id) {
  if (when === undefined) return undefined;
  if (!isPlainObject(when)) fail(`${id} : « when » doit être un objet.`);
  for (const key of Object.keys(when)) if (!['timeZone', 'days', 'from', 'to'].includes(key)) fail(`${id} : clé inconnue « when.${key} ».`);
  const timeZone = when.timeZone ?? 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch (_error) { fail(`${id} : fuseau horaire inconnu ${timeZone}.`); }
  const days = when.days === undefined ? undefined : [...new Set(when.days)];
  if (days && (!days.length || !days.every((d) => Number.isSafeInteger(d) && d >= 1 && d <= 7))) fail(`${id} : « days » de 1 (lundi) à 7 (dimanche).`);
  if ((when.from === undefined) !== (when.to === undefined)) fail(`${id} : « from » et « to » vont ensemble.`);
  if (when.from !== undefined && (!TIME.test(when.from) || !TIME.test(when.to) || when.from === when.to)) fail(`${id} : heures au format HH:MM, différentes.`);
  if (!days && when.from === undefined) fail(`${id} : « when » sans jour ni heure.`);
  return Object.freeze({ timeZone, days: days && Object.freeze(days), from: when.from, to: when.to });
}

/** Vérifie et gèle une liste de règles. */
function normalizeRules(rules, origin = 'local') {
  if (rules === undefined || rules === null) return Object.freeze([]);
  if (!Array.isArray(rules)) fail('Les règles doivent être une liste.');
  const seen = new Set();
  return Object.freeze(rules.map((rule, index) => {
    const id = rule?.id ?? `#${index}`;
    if (!isPlainObject(rule)) fail(`${id} : une règle doit être un objet.`);
    for (const key of Object.keys(rule)) if (!['id', 'level', 'match', 'approvals', 'quota'].includes(key)) fail(`${id} : clé inconnue « ${key} ».`);
    if (typeof rule.id !== 'string' || !NAME.test(rule.id)) fail(`${id} : identifiant de règle invalide.`);
    if (seen.has(rule.id)) fail(`${id} : identifiant en double.`);
    seen.add(rule.id);
    if (!LEVELS.includes(rule.level)) fail(`${id} : niveau inconnu ${String(rule.level)}.`);
    const match = rule.match ?? {};
    if (!isPlainObject(match)) fail(`${id} : « match » doit être un objet.`);
    for (const key of Object.keys(match)) if (!['ops', 'resources', 'tags', 'agents', 'rowsAbove', 'amountAbove', 'when'].includes(key)) fail(`${id} : critère inconnu « ${key} ».`);
    const ops = names(match.ops, 'ops', id);
    if (ops && !ops.every((op) => OPERATIONS.includes(op))) fail(`${id} : opération inconnue.`);
    const approvals = rule.approvals ?? 1;
    if (!Number.isSafeInteger(approvals) || approvals < 1 || approvals > 5) fail(`${id} : « approvals » de 1 à 5.`);
    let quota;
    if (rule.quota !== undefined) {
      if (!isPlainObject(rule.quota) || !Number.isSafeInteger(rule.quota.perDay) || rule.quota.perDay < 0) fail(`${id} : « quota.perDay » doit être un entier positif.`);
      quota = Object.freeze({ perDay: rule.quota.perDay });
    }
    return Object.freeze({
      id: rule.id, origin, level: rule.level, approvals, quota,
      match: Object.freeze({
        ops, resources: names(match.resources, 'resources', id), tags: names(match.tags, 'tags', id), agents: names(match.agents, 'agents', id),
        rowsAbove: threshold(match.rowsAbove, 'rowsAbove', id), amountAbove: threshold(match.amountAbove, 'amountAbove', id), when: normalizeWhen(match.when, id)
      })
    });
  }));
}

const formatters = new Map();
function localClock(at, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { day, time: `${parts.hour}:${parts.minute}` };
}

/** Vrai si l'instant tombe dans la plage (une plage qui passe minuit, 22:00 → 06:00, est permise). */
function withinWhen(when, at) {
  const { day, time } = localClock(at, when.timeZone);
  if (when.days && !when.days.includes(day)) return false;
  if (when.from === undefined) return true;
  return when.from < when.to ? time >= when.from && time < when.to : time >= when.from || time < when.to;
}

function ruleMatches(rule, facts) {
  const m = rule.match;
  if (m.ops && !facts.ops.some((op) => m.ops.includes(op))) return false;
  if (m.resources && !m.resources.includes(facts.resource)) return false;
  if (m.tags && !facts.tags.some((tag) => m.tags.includes(tag))) return false;
  if (m.agents && !m.agents.includes(facts.agent)) return false;
  if (m.rowsAbove !== undefined && !(facts.rows > m.rowsAbove)) return false;
  if (m.amountAbove !== undefined && !(facts.amount > m.amountAbove)) return false;
  if (m.when && !withinWhen(m.when, facts.at)) return false;
  return true;
}

/**
 * Le niveau d'une proposition. Les critères se lisent par ressource, actions regroupées
 * (nombre de lignes et montant additionnés) : découper une grosse modification en petites
 * actions ne fait pas passer sous un seuil.
 * `groups` : [{ resource, ops, tags, rows, amount }] ; rend { level, approvals, matched, quotaRules }.
 */
function decideLevel({ groups, agent, at, rules }) {
  let level = 'free';
  let approvals = 1;
  const matched = [];
  for (const group of groups) {
    const facts = { ...group, agent, at };
    const hits = rules.filter((rule) => ruleMatches(rule, facts));
    const groupLevel = hits.length ? hits.reduce((current, rule) => stricter(current, rule.level), 'free') : DEFAULT_LEVEL;
    for (const rule of hits) {
      matched.push({ id: rule.id, origin: rule.origin, level: rule.level, resource: group.resource });
      if (rule.level === 'validation' && groupLevel === 'validation') approvals = Math.max(approvals, rule.approvals);
    }
    if (!hits.length) matched.push({ id: null, origin: 'default', level: DEFAULT_LEVEL, resource: group.resource });
    level = stricter(level, groupLevel);
  }
  /* Les quotas qui comptent : ceux des règles qui ont donné le niveau final (libre ou libre avec avis). */
  const quotaRules = rules.filter((rule) => rule.quota && rule.level === level && matched.some((m) => m.id === rule.id && m.origin === rule.origin));
  return { level, approvals, matched, quotaRules };
}

module.exports = { LEVELS, DEFAULT_LEVEL, normalizeRules, decideLevel, stricter, withinWhen, rank };
