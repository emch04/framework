'use strict';
const { GouvernanceError } = require('../errors');
const { defineResources, IDENTIFIER } = require('../contract');

/*
 * PostgreSQL : un connecteur (aperçu, revérification, écriture tout ou rien) et un magasin des
 * propositions. Les deux reçoivent un Pool de `pg` et n'ouvrent aucune connexion eux-mêmes.
 * Mettre le magasin dans la MÊME base que les données : l'état « exécutée » est alors écrit
 * dans la même transaction que les lignes, et une panne ne laisse jamais l'un sans l'autre.
 */

const ISOLATIONS = Object.freeze({ 'repeatable read': 'REPEATABLE READ', serializable: 'SERIALIZABLE' });
/* Conflits de concurrence : la donnée a bougé pendant qu'on écrivait. */
const CONCURRENCY = new Set(['23505', '40001', '40P01']);

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const quoteTable = (table) => table.split('.').map(quote).join('.');

function whereSql(where, params) {
  const parts = [];
  for (const [column, condition] of Object.entries(where)) {
    const c = quote(column);
    for (const [op, value] of Object.entries(condition)) {
      if (op === 'isNull') { parts.push(`${c} IS ${value ? '' : 'NOT '}NULL`); continue; }
      if (op === 'eq' && value === null) { parts.push(`${c} IS NULL`); continue; }
      if (op === 'ne' && value === null) { parts.push(`${c} IS NOT NULL`); continue; }
      params.push(value);
      const p = `$${params.length}`;
      if (op === 'in') parts.push(`${c} = ANY(${p})`);
      else parts.push(`${c} ${{ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]} ${p}`);
    }
  }
  return parts.join(' AND ');
}

function keysSql(resource, keys, params) {
  return keys.map((key) => `(${resource.key.map((column) => { params.push(key[column]); return `${quote(column)} = $${params.length}`; }).join(' AND ')})`).join(' OR ');
}

function selection(resource, select, params) {
  return select.where ? whereSql(select.where, params) : keysSql(resource, select.keys, params);
}

/**
 * createPostgresConnector({ pool, resources, isolation = 'repeatable read' })
 * `resources` : voir defineResources ; `table` peut être « schéma.table ».
 */
function createPostgresConnector({ pool, resources, isolation = 'repeatable read' } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new GouvernanceError('connector_invalid', 'Un Pool de pg est obligatoire.');
  if (!ISOLATIONS[isolation]) throw new GouvernanceError('connector_invalid', 'isolation : « repeatable read » ou « serializable ».');
  const declared = defineResources(resources);
  const columnsOf = (resource) => resource.readable.map(quote).join(', ');
  const orderOf = (resource) => resource.key.map(quote).join(', ');

  async function preview(action, { limit }) {
    const resource = declared[action.resource];
    const params = [];
    const filter = action.op === 'insert'
      ? keysSql(resource, [Object.fromEntries(resource.key.map((column) => [column, action.values[column]]))], params)
      : whereSql(action.where, params);
    params.push(limit);
    const { rows } = await pool.query(`SELECT ${columnsOf(resource)} FROM ${quoteTable(resource.table)} WHERE ${filter} ORDER BY ${orderOf(resource)} LIMIT $${params.length}`, params);
    return { rows };
  }

  async function execute(plan, { finalize }) {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${ISOLATIONS[isolation]}`);
      open = true;
      let rowsAffected = 0;
      for (const step of plan.steps) {
        const resource = declared[step.resource];
        const params = [];
        /* Verrouille les lignes ET relit le filtre : une ligne apparue depuis l'aperçu se voit ici. */
        const { rows } = await client.query(`SELECT ${columnsOf(resource)} FROM ${quoteTable(resource.table)} WHERE ${selection(resource, step.select, params)} ORDER BY ${orderOf(resource)} FOR UPDATE`, params);
        const problem = plan.compare(step, rows);
        if (problem) { await client.query('ROLLBACK'); open = false; return { ok: false, code: 'stale_data', detail: problem }; }
        for (const write of step.writes) {
          const p = [];
          let result;
          if (write.kind === 'update') {
            const set = Object.entries(write.set).map(([column, value]) => { p.push(value); return `${quote(column)} = $${p.length}`; }).join(', ');
            result = await client.query(`UPDATE ${quoteTable(resource.table)} SET ${set} WHERE ${keysSql(resource, [write.key], p)}`, p);
          } else if (write.kind === 'delete') {
            result = await client.query(`DELETE FROM ${quoteTable(resource.table)} WHERE ${keysSql(resource, [write.key], p)}`, p);
          } else {
            const columns = Object.keys(write.values);
            for (const column of columns) if (!IDENTIFIER.test(column)) throw new GouvernanceError('invalid_action', `Colonne invalide : ${column}.`);
            columns.forEach((column) => p.push(write.values[column]));
            result = await client.query(`INSERT INTO ${quoteTable(resource.table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`, p);
          }
          if (result.rowCount !== 1) { await client.query('ROLLBACK'); open = false; return { ok: false, code: 'stale_data', detail: { action: step.action, reason: 'row_count' } }; }
          rowsAffected += 1;
        }
      }
      await finalize({ rowsAffected, client });
      await client.query('COMMIT');
      open = false;
      return { ok: true, rowsAffected };
    } catch (error) {
      if (open) { try { await client.query('ROLLBACK'); } catch (_e) { /* la connexion est peut-être perdue */ } }
      if (CONCURRENCY.has(error.code)) return { ok: false, code: 'stale_data', detail: { reason: 'concurrent' } };
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ kind: 'postgres', resources: declared, preview, execute });
}

const PREFIX = /^[a-z_][a-z0-9_]{0,40}$/;
function tables(prefix = 'gouvernance') {
  if (!PREFIX.test(prefix)) throw new GouvernanceError('store_invalid', 'Préfixe de tables invalide.');
  return { proposals: `${prefix}_proposals` };
}

/** Le SQL des tables du magasin (idempotent : à lancer au démarrage ou dans une migration). */
function postgresGovernanceSchema({ prefix } = {}) {
  const t = tables(prefix);
  return `
CREATE TABLE IF NOT EXISTS ${t.proposals} (
  organisation_id text NOT NULL,
  id text NOT NULL,
  digest text NOT NULL,
  status text NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (organisation_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ${t.proposals}_idempotency ON ${t.proposals} (organisation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${t.proposals}_status ON ${t.proposals} (organisation_id, status, created_at DESC);
`;
}

/** Magasin des propositions dans PostgreSQL. Chaque méthode qui écrit accepte { client } pour suivre une transaction. */
function createPostgresGovernanceStore(pool, { prefix } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new GouvernanceError('store_invalid', 'Un Pool de pg est obligatoire.');
  const t = tables(prefix);
  const one = (rows) => (rows[0] ? rows[0].data : null);
  return Object.freeze({
    async put(record) {
      const { rows } = await pool.query(
        `INSERT INTO ${t.proposals} (organisation_id, id, digest, status, idempotency_key, created_at, expires_at, updated_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) ON CONFLICT DO NOTHING RETURNING data`,
        [record.organisationId, record.id, record.digest, record.status, record.idempotencyKey, record.createdAt, record.expiresAt, record.updatedAt, JSON.stringify(record)]);
      if (rows[0]) return { record: rows[0].data, created: true };
      const existing = await this.get(record.organisationId, record.id)
        ?? (record.idempotencyKey ? await this.findByIdempotencyKey(record.organisationId, record.idempotencyKey) : null);
      if (!existing || existing.digest !== record.digest) throw new GouvernanceError('proposal_conflict', 'Une autre proposition porte déjà cet identifiant.');
      return { record: existing, created: false };
    },
    async get(organisationId, id) {
      const { rows } = await pool.query(`SELECT data FROM ${t.proposals} WHERE organisation_id = $1 AND id = $2`, [organisationId, id]);
      return one(rows);
    },
    async findByIdempotencyKey(organisationId, idempotencyKey) {
      const { rows } = await pool.query(`SELECT data FROM ${t.proposals} WHERE organisation_id = $1 AND idempotency_key = $2`, [organisationId, idempotencyKey]);
      return one(rows);
    },
    /** Change l'état seulement s'il est encore dans `from` : un seul gagnant, même à plusieurs processus. */
    async transition(organisationId, id, { from, to, patch = {}, at }, { client } = {}) {
      const db = client ?? pool;
      const { rows } = await db.query(
        `UPDATE ${t.proposals} SET status = $3, updated_at = $4, data = data || $5::jsonb
         WHERE organisation_id = $1 AND id = $2 AND status = ANY($6::text[]) RETURNING data`,
        [organisationId, id, to, at, JSON.stringify({ ...patch, status: to, updatedAt: at }), from]);
      return one(rows);
    },
    async list({ organisationId, status, limit = 100 } = {}) {
      const params = [organisationId];
      let filter = '';
      if (status !== undefined) { params.push(Array.isArray(status) ? status : [status]); filter = ` AND status = ANY($${params.length}::text[])`; }
      params.push(Math.min(Math.max(1, limit), 1000));
      const { rows } = await pool.query(`SELECT data FROM ${t.proposals} WHERE organisation_id = $1${filter} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return rows.map((row) => row.data);
    }
  });
}

module.exports = { createPostgresConnector, createPostgresGovernanceStore, postgresGovernanceSchema };
