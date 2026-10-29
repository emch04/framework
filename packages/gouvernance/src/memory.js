'use strict';
const { GouvernanceError } = require('./errors');
const { defineResources, rowMatches } = require('./contract');
const { toJsonValue } = require('./stable');

/*
 * Magasin et connecteur gardés en mémoire : perdus à l'arrêt du processus. Pour les tests et
 * pour essayer le pack ; en production, le magasin PostgreSQL dans la même base que les données.
 */

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Magasin des propositions en mémoire. Les transitions sont atomiques (un seul fil). */
function createMemoryGovernanceStore() {
  const records = new Map();
  const keyOf = (organisationId, id) => `${organisationId}\u0000${id}`;
  return {
    async put(record) {
      const key = keyOf(record.organisationId, record.id);
      const existing = records.get(key);
      if (existing) {
        if (existing.digest !== record.digest) throw new GouvernanceError('proposal_conflict', 'Une autre proposition porte déjà cet identifiant.');
        return { record: copy(existing), created: false };
      }
      records.set(key, copy(record));
      return { record: copy(record), created: true };
    },
    async get(organisationId, id) { return copy(records.get(keyOf(organisationId, id))) ?? null; },
    async findByIdempotencyKey(organisationId, idempotencyKey) {
      for (const record of records.values()) if (record.organisationId === organisationId && record.idempotencyKey === idempotencyKey) return copy(record);
      return null;
    },
    async transition(organisationId, id, { from, to, patch = {}, at }) {
      const record = records.get(keyOf(organisationId, id));
      if (!record || !from.includes(record.status)) return null;
      Object.assign(record, copy(patch), { status: to, updatedAt: at });
      return copy(record);
    },
    async list({ organisationId, status, limit = 100 } = {}) {
      return [...records.values()]
        .filter((r) => r.organisationId === organisationId && (status === undefined || (Array.isArray(status) ? status.includes(r.status) : r.status === status)))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map(copy);
    }
  };
}

const keyText = (resource, row) => JSON.stringify(resource.key.map((column) => row[column]));

/**
 * Connecteur en mémoire : des tables JS ({ ressource: [lignes] }). Même contrat que les
 * connecteurs réels ; l'exécution travaille sur une copie et ne la publie qu'à la fin (tout ou rien).
 */
function createMemoryConnector({ resources, data = {} }) {
  const declared = defineResources(resources);
  let tables = Object.fromEntries(Object.keys(declared).map((name) => [name, copy(data[name] ?? [])]));
  const project = (resource, row) => Object.fromEntries(resource.readable.map((column) => [column, toJsonValue(row[column] ?? null)]));
  const select = (resource, rows, selection) => (selection.where
    ? rows.filter((row) => rowMatches(row, selection.where))
    : rows.filter((row) => selection.keys.some((key) => resource.key.every((column) => row[column] === key[column]))));
  return {
    kind: 'memory',
    resources: declared,
    /** Lignes qui correspondent maintenant (au plus `limit`), ou la ligne d'une clé pour un ajout. */
    async preview(action, { limit }) {
      const resource = declared[action.resource];
      const rows = tables[resource.name];
      if (action.op === 'insert') {
        const key = Object.fromEntries(resource.key.map((column) => [column, action.values[column]]));
        return { rows: select(resource, rows, { keys: [key] }).map((row) => project(resource, row)) };
      }
      return { rows: select(resource, rows, { where: action.where }).slice(0, limit).map((row) => project(resource, row)) };
    },
    async execute(plan, { finalize }) {
      const next = copy(tables);
      let rowsAffected = 0;
      for (const step of plan.steps) {
        const resource = declared[step.resource];
        const rows = next[resource.name];
        const found = select(resource, rows, step.select).map((row) => project(resource, row));
        const problem = plan.compare(step, found);
        if (problem) return { ok: false, code: 'stale_data', detail: problem };
        for (const write of step.writes) {
          const index = rows.findIndex((row) => keyText(resource, row) === keyText(resource, write.key));
          if (write.kind === 'update') { Object.assign(rows[index], write.set); rowsAffected += 1; }
          if (write.kind === 'delete') { rows.splice(index, 1); rowsAffected += 1; }
          if (write.kind === 'insert') { rows.push({ ...write.values }); rowsAffected += 1; }
        }
      }
      await finalize({ rowsAffected, client: null });
      tables = next;
      return { ok: true, rowsAffected };
    },
    /** Pour les tests : l'état courant, et une écriture « par quelqu'un d'autre ». */
    snapshot: (name) => copy(tables[name]),
    mutate: (name, fn) => { fn(tables[name]); }
  };
}

module.exports = { createMemoryGovernanceStore, createMemoryConnector };
