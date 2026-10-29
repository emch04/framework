'use strict';
const { GouvernanceError } = require('./errors');

/*
 * Le contrat : ce que l'application déclare (ses ressources) et ce qu'une IA peut proposer
 * (des actions fermées). L'IA ne donne jamais de SQL ni de requête libre : une action est un
 * objet dont chaque clé est connue, chaque colonne déclarée, chaque valeur simple.
 */

const PROPOSAL_SCHEMA = 'gouvernance-proposition/1';
const VALIDATION_SCHEMA = 'gouvernance-validation/1';
const CHALLENGE_SCHEMA = 'gouvernance-defi/1';
const RESULT_SCHEMA = 'gouvernance-resultat/1';

const OPERATIONS = Object.freeze(['insert', 'update', 'delete']);
const COLUMN_TYPES = Object.freeze(['objectId', 'date']);
const COMPARISONS = Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'isNull']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MAX_IN = 500;
const MAX_ACTIONS = 20;

const fail = (code, message) => { throw new GouvernanceError(code, message); };
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const isScalar = (value) => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const unique = (list) => [...new Set(list)];

function onlyKeys(object, allowed, where) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail('invalid_action', `${where} : clé inconnue « ${key} ».`);
}

function columnList(value, label, resource) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  for (const column of list) if (typeof column !== 'string' || !IDENTIFIER.test(column)) fail('invalid_resources', `${resource} : colonne ${label} invalide (${String(column)}).`);
  return unique(list);
}

/**
 * Vérifie et gèle la déclaration des ressources d'un connecteur.
 * { nom: { table, key, writable, filterable?, sensitive?, tags?, amount?, maxRows?, operations? } }
 */
function defineResources(declaration) {
  if (!isPlainObject(declaration) || !Object.keys(declaration).length) fail('invalid_resources', 'Déclarer au moins une ressource.');
  const resources = {};
  for (const [name, spec] of Object.entries(declaration)) {
    if (!NAME.test(name)) fail('invalid_resources', `Nom de ressource invalide : ${name}.`);
    if (!isPlainObject(spec)) fail('invalid_resources', `${name} : la déclaration doit être un objet.`);
    onlyKeys(spec, ['table', 'key', 'writable', 'filterable', 'sensitive', 'tags', 'amount', 'maxRows', 'operations', 'types'], name);
    if (typeof spec.table !== 'string' || !TABLE.test(spec.table)) fail('invalid_resources', `${name} : table ou collection invalide.`);
    const key = columnList(spec.key, 'clé', name);
    if (!key.length) fail('invalid_resources', `${name} : une clé primaire est obligatoire.`);
    const writable = columnList(spec.writable, 'modifiable', name);
    const filterable = columnList(spec.filterable, 'filtrable', name);
    const sensitive = columnList(spec.sensitive, 'sensible', name);
    if (writable.some((column) => key.includes(column))) fail('invalid_resources', `${name} : une colonne de clé ne se modifie pas.`);
    const readable = unique([...key, ...writable, ...filterable]);
    for (const column of sensitive) {
      if (key.includes(column)) fail('invalid_resources', `${name} : une colonne de clé ne peut pas être sensible (la personne doit voir quelle ligne change).`);
      if (!readable.includes(column)) fail('invalid_resources', `${name} : la colonne sensible ${column} n'est pas déclarée.`);
    }
    const operations = spec.operations === undefined ? ['update'] : unique(spec.operations);
    for (const op of operations) if (!OPERATIONS.includes(op)) fail('invalid_resources', `${name} : opération inconnue ${op}.`);
    if (operations.some((op) => op !== 'delete') && !writable.length) fail('invalid_resources', `${name} : aucune colonne modifiable.`);
    const tags = spec.tags === undefined ? [] : unique(spec.tags);
    for (const tag of tags) if (typeof tag !== 'string' || !NAME.test(tag)) fail('invalid_resources', `${name} : étiquette invalide.`);
    if (spec.amount !== undefined && (typeof spec.amount !== 'string' || !writable.includes(spec.amount))) fail('invalid_resources', `${name} : la colonne de montant doit être modifiable.`);
    /* Le type d'une colonne quand la base ne le déduit pas d'un texte (MongoDB) : identifiant ObjectId, date. */
    const types = spec.types === undefined ? {} : spec.types;
    if (!isPlainObject(types)) fail('invalid_resources', `${name} : « types » doit être un objet.`);
    for (const [column, type] of Object.entries(types)) {
      if (!readable.includes(column)) fail('invalid_resources', `${name} : la colonne typée ${column} n'est pas déclarée.`);
      if (!COLUMN_TYPES.includes(type)) fail('invalid_resources', `${name} : type inconnu ${String(type)} (${COLUMN_TYPES.join(', ')}).`);
    }
    const maxRows = spec.maxRows === undefined ? 100 : spec.maxRows;
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10000) fail('invalid_resources', `${name} : maxRows doit être un entier de 1 à 10 000.`);
    resources[name] = Object.freeze({
      name, table: spec.table, key: Object.freeze(key), writable: Object.freeze(writable), filterable: Object.freeze(filterable),
      readable: Object.freeze(readable), sensitive: Object.freeze(sensitive), tags: Object.freeze(tags), amount: spec.amount ?? null,
      maxRows, operations: Object.freeze(operations), types: Object.freeze({ ...types })
    });
  }
  return Object.freeze(resources);
}

function normalizeCondition(column, condition) {
  if (isScalar(condition)) return { eq: condition };
  if (!isPlainObject(condition) || !Object.keys(condition).length) fail('invalid_action', `Filtre invalide sur ${column}.`);
  onlyKeys(condition, COMPARISONS, `filtre de ${column}`);
  const out = {};
  for (const [op, value] of Object.entries(condition)) {
    if (op === 'in') {
      if (!Array.isArray(value) || !value.length || value.length > MAX_IN || !value.every((v) => isScalar(v) && v !== null)) fail('invalid_action', `« in » sur ${column} : de 1 à ${MAX_IN} valeurs simples.`);
      out.in = unique(value);
    } else if (op === 'isNull') {
      if (typeof value !== 'boolean') fail('invalid_action', `« isNull » sur ${column} : vrai ou faux.`);
      out.isNull = value;
    } else {
      if (!isScalar(value) || value === null) fail('invalid_action', `« ${op} » sur ${column} : une valeur simple (pour null, isNull).`);
      if (['gt', 'gte', 'lt', 'lte'].includes(op) && typeof value === 'boolean') fail('invalid_action', `« ${op} » sur ${column} : un nombre ou un texte.`);
      out[op] = value;
    }
  }
  return out;
}

function normalizeWhere(where, resource) {
  if (!isPlainObject(where) || !Object.keys(where).length) fail('invalid_action', `${resource.name} : un filtre « where » est obligatoire (jamais toute la table).`);
  const allowed = unique([...resource.key, ...resource.filterable]);
  const out = {};
  for (const column of Object.keys(where).sort()) {
    if (!allowed.includes(column)) fail('column_not_filterable', `${resource.name} : la colonne ${column} n'est pas filtrable.`);
    out[column] = normalizeCondition(column, where[column]);
  }
  return out;
}

function normalizeSet(set, resource) {
  if (!isPlainObject(set) || !Object.keys(set).length) fail('invalid_action', `${resource.name} : « set » est obligatoire.`);
  const out = {};
  for (const column of Object.keys(set).sort()) {
    if (!resource.writable.includes(column)) fail('column_not_writable', `${resource.name} : la colonne ${column} n'est pas modifiable.`);
    const value = set[column];
    if (isScalar(value)) { out[column] = { value }; continue; }
    if (!isPlainObject(value)) fail('invalid_action', `${resource.name}.${column} : valeur invalide.`);
    onlyKeys(value, ['increment', 'multiply', 'round'], `${resource.name}.${column}`);
    const hasIncrement = value.increment !== undefined;
    const hasMultiply = value.multiply !== undefined;
    if (hasIncrement === hasMultiply) fail('invalid_action', `${resource.name}.${column} : « increment » ou « multiply », un seul.`);
    const factor = hasIncrement ? value.increment : value.multiply;
    if (typeof factor !== 'number' || !Number.isFinite(factor)) fail('invalid_action', `${resource.name}.${column} : un nombre fini.`);
    const round = value.round ?? null;
    if (round !== null && (!Number.isSafeInteger(round) || round < 0 || round > 10)) fail('invalid_action', `${resource.name}.${column} : « round » de 0 à 10 décimales.`);
    out[column] = hasIncrement ? { increment: factor, round } : { multiply: factor, round };
  }
  return out;
}

function normalizeValues(values, resource) {
  if (!isPlainObject(values) || !Object.keys(values).length) fail('invalid_action', `${resource.name} : « values » est obligatoire.`);
  const allowed = unique([...resource.key, ...resource.writable]);
  const out = {};
  for (const column of Object.keys(values).sort()) {
    if (!allowed.includes(column)) fail('column_not_writable', `${resource.name} : la colonne ${column} ne s'écrit pas.`);
    if (!isScalar(values[column])) fail('invalid_action', `${resource.name}.${column} : une valeur simple.`);
    out[column] = values[column];
  }
  for (const column of resource.key) if (out[column] === undefined || out[column] === null) fail('invalid_action', `${resource.name} : la clé ${column} est obligatoire pour ajouter une ligne.`);
  return out;
}

/** Une action proposée, vérifiée et mise sous forme canonique (clés triées, filtres explicites). */
function normalizeAction(action, connectors) {
  if (!isPlainObject(action)) fail('invalid_action', 'Une action doit être un objet.');
  onlyKeys(action, ['connector', 'resource', 'op', 'where', 'set', 'values'], 'action');
  const connector = connectors[action.connector];
  if (typeof action.connector !== 'string' || !connector) fail('unknown_connector', `Connecteur inconnu : ${String(action.connector)}.`);
  const resource = connector.resources[action.resource];
  if (typeof action.resource !== 'string' || !resource) fail('unknown_resource', `Ressource inconnue : ${String(action.resource)}.`);
  if (!OPERATIONS.includes(action.op)) fail('invalid_action', `Opération inconnue : ${String(action.op)}.`);
  if (!resource.operations.includes(action.op)) fail('operation_not_allowed', `${resource.name} : l'opération ${action.op} n'est pas permise.`);
  const base = { connector: action.connector, resource: resource.name, op: action.op };
  if (action.op === 'insert') {
    if (action.where !== undefined || action.set !== undefined) fail('invalid_action', 'Un ajout ne prend que « values ».');
    return { ...base, values: normalizeValues(action.values, resource) };
  }
  if (action.values !== undefined) fail('invalid_action', '« values » ne sert qu\'aux ajouts.');
  if (action.op === 'delete') {
    if (action.set !== undefined) fail('invalid_action', 'Une suppression ne prend que « where ».');
    return { ...base, where: normalizeWhere(action.where, resource) };
  }
  return { ...base, where: normalizeWhere(action.where, resource), set: normalizeSet(action.set, resource) };
}

function normalizeActions(actions, connectors) {
  if (!Array.isArray(actions) || !actions.length) fail('invalid_action', 'Proposer au moins une action.');
  if (actions.length > MAX_ACTIONS) fail('too_many_actions', `${MAX_ACTIONS} actions au plus par proposition.`);
  return actions.map((action) => normalizeAction(action, connectors));
}

/** Vrai si la ligne satisfait le filtre canonique (même logique que le SQL du connecteur, pour les ajouts et les tests). */
function rowMatches(row, where) {
  return Object.entries(where).every(([column, condition]) => Object.entries(condition).every(([op, value]) => {
    const current = row[column];
    switch (op) {
      case 'eq': return current === value;
      case 'ne': return current !== value && current !== null && current !== undefined;
      case 'gt': return current > value;
      case 'gte': return current >= value;
      case 'lt': return current < value;
      case 'lte': return current <= value;
      case 'in': return value.includes(current);
      case 'isNull': return value ? current === null || current === undefined : current !== null && current !== undefined;
      default: return false;
    }
  }));
}

module.exports = {
  PROPOSAL_SCHEMA, VALIDATION_SCHEMA, CHALLENGE_SCHEMA, RESULT_SCHEMA, OPERATIONS, COMPARISONS, MAX_ACTIONS, COLUMN_TYPES,
  IDENTIFIER, NAME, defineResources, normalizeActions, normalizeAction, rowMatches, isPlainObject, isScalar
};
