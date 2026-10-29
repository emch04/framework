'use strict';
const crypto = require('node:crypto');
const { GouvernanceError } = require('./errors');

/*
 * Sérialisation stable : clés triées, aucun espace. Deux machines qui lisent la même
 * proposition obtiennent la même chaîne, donc la même empreinte. Tout ce qui n'a pas de
 * forme JSON unique (undefined, fonction, NaN, Infinity, bigint, octets) est refusé plutôt
 * que deviné.
 */
function stableStringify(value) {
  if (value === null) return 'null';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new GouvernanceError('invalid_value', 'Une date invalide ne se sérialise pas.');
    return JSON.stringify(value.toISOString());
  }
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new GouvernanceError('invalid_value', 'Un nombre doit être fini.');
      return JSON.stringify(value);
    case 'object': {
      if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) throw new GouvernanceError('invalid_value', 'Des octets ne se sérialisent pas : les convertir d\'abord.');
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => {
        if (value[key] === undefined) throw new GouvernanceError('invalid_value', `La clé ${key} n'a pas de valeur.`);
        return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
      }).join(',')}}`;
    }
    default:
      throw new GouvernanceError('invalid_value', `Une valeur de type ${typeof value} ne se sérialise pas.`);
  }
}

/** SHA-256 de la sérialisation stable, en base64url. */
function digestOf(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('base64url');
}

/** HMAC-SHA256 salé : pour les versions de lignes et les valeurs masquées, que le service de validation ne peut pas deviner. */
function keyedDigest(salt, value) {
  return crypto.createHmac('sha256', Buffer.from(salt, 'base64url')).update(stableStringify(value), 'utf8').digest('base64url');
}

/** Copie JSON pure : dates en ISO, bigint en texte ; le reste doit déjà être du JSON. */
function toJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) throw new GouvernanceError('invalid_value', 'Une colonne d\'octets ne peut pas être gouvernée.');
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).map((key) => [key, toJsonValue(value[key])]));
  if (typeof value === 'number' && !Number.isFinite(value)) throw new GouvernanceError('invalid_value', 'Un nombre doit être fini.');
  return value;
}

/** Comparaison prudente : même forme stable, ou deux écritures du même nombre ("12.50" et 12.5). */
function sameValue(a, b) {
  const x = toJsonValue(a);
  const y = toJsonValue(b);
  if (stableStringify(x) === stableStringify(y)) return true;
  const numeric = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const nx = numeric(x);
  const ny = numeric(y);
  return nx !== null && ny !== null && (typeof x === 'number' || typeof y === 'number') && nx === ny;
}

const randomSalt = () => crypto.randomBytes(32).toString('base64url');

module.exports = { stableStringify, digestOf, keyedDigest, toJsonValue, sameValue, randomSalt };
