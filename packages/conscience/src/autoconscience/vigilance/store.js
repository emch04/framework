'use strict';
/*
 * Storage of the vigilance module: follow-up commitments (18) and candidate
 * scenarios waiting for review (03, 27). A memory store and a PostgreSQL store
 * with the same contract. Every read and write is scoped by organisation.
 */
const { copy, prefixOf, requireQueryable } = require('../../governor/util');

const MAX_LIMIT = 10000;
const limitOf = (value) => Math.min(Math.max(Number(value) || 1000, 1), MAX_LIMIT);
const DEFAULT_PREFIX = 'astratra_vigilance';
const keyOf = (organisationId, id) => `${organisationId}\u0000${id}`;

function matchesFollowUp(row, filter) {
  if (row.organisationId !== filter.organisationId) return false;
  if (filter.userId !== undefined && row.userId !== filter.userId) return false;
  if (filter.decisionId !== undefined && row.decisionId !== filter.decisionId) return false;
  if (filter.status !== undefined && row.status !== filter.status) return false;
  if (filter.observableTo !== undefined && row.observableAt > filter.observableTo) return false;
  return true;
}

function createMemoryVigilanceStore() {
  const followUps = new Map();
  const candidates = new Map();
  return {
    async putFollowUp(record) {
      const key = keyOf(record.organisationId, record.id);
      if (followUps.has(key)) return { record: copy(followUps.get(key)), created: false };
      followUps.set(key, copy(record));
      return { record: copy(record), created: true };
    },
    async getFollowUp(organisationId, id) { return copy(followUps.get(keyOf(organisationId, id)) ?? null); },
    async listFollowUps(filter = {}) {
      return [...followUps.values()].filter((row) => matchesFollowUp(row, filter))
        .sort((a, b) => (a.observableAt < b.observableAt ? -1 : a.observableAt > b.observableAt ? 1 : a.id < b.id ? -1 : 1))
        .slice(0, limitOf(filter.limit)).map(copy);
    },
    async updateFollowUp(organisationId, id, expectedStatus, patch) {
      const key = keyOf(organisationId, id);
      const row = followUps.get(key);
      if (!row || row.status !== expectedStatus) return null;
      const next = { ...row, ...copy(patch) };
      followUps.set(key, next);
      return copy(next);
    },
    async removeFollowUps({ organisationId, userId }) {
      let count = 0;
      for (const [key, row] of followUps) if (row.organisationId === organisationId && row.userId === userId) { followUps.delete(key); count += 1; }
      return count;
    },
    async putCandidate(record) {
      const key = keyOf(record.organisationId, record.id);
      if (candidates.has(key)) return { record: copy(candidates.get(key)), created: false };
      candidates.set(key, copy(record));
      return { record: copy(record), created: true };
    },
    async getCandidate(organisationId, id) { return copy(candidates.get(keyOf(organisationId, id)) ?? null); },
    async listCandidates(filter = {}) {
      return [...candidates.values()]
        .filter((row) => row.organisationId === filter.organisationId && (filter.agentId === undefined || row.agentId === filter.agentId))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
        .slice(0, limitOf(filter.limit)).map(copy);
    }
  };
}

/** SQL that creates the vigilance tables. Idempotent. */
function postgresVigilanceSchema(options) {
  const p = prefixOf(options, DEFAULT_PREFIX);
  return `CREATE TABLE IF NOT EXISTS "${p}_follow_ups" (
  organisation_id text NOT NULL,
  id text NOT NULL,
  user_id text,
  agent_id text,
  decision_id text NOT NULL,
  observable_at timestamptz NOT NULL,
  status text NOT NULL,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  envelope jsonb NOT NULL,
  PRIMARY KEY (organisation_id, id)
);
CREATE INDEX IF NOT EXISTS "${p}_follow_ups_due_idx" ON "${p}_follow_ups" (organisation_id, status, observable_at);
CREATE INDEX IF NOT EXISTS "${p}_follow_ups_user_idx" ON "${p}_follow_ups" (organisation_id, user_id);
CREATE TABLE IF NOT EXISTS "${p}_candidates" (
  organisation_id text NOT NULL,
  id text NOT NULL,
  agent_id text,
  proposal_id text,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  envelope jsonb NOT NULL,
  PRIMARY KEY (organisation_id, id)
);
CREATE INDEX IF NOT EXISTS "${p}_candidates_agent_idx" ON "${p}_candidates" (organisation_id, agent_id, created_at);`;
}

const read = (row) => (row ? (typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope) : null);

/** Vigilance store on PostgreSQL. `db` is any `{ query(sql, params) }`; every value is a parameter. */
function createPostgresVigilanceStore(db, options) {
  requireQueryable(db);
  const p = prefixOf(options, DEFAULT_PREFIX);
  const fu = `"${p}_follow_ups"`, ca = `"${p}_candidates"`;
  const fuColumns = (r) => [r.organisationId, r.id, r.userId, r.agentId, r.decisionId, r.observableAt, r.status, r.fingerprint, r.createdAt, JSON.stringify(r)];
  return {
    async putFollowUp(record) {
      const inserted = await db.query(
        `INSERT INTO ${fu} (organisation_id, id, user_id, agent_id, decision_id, observable_at, status, fingerprint, created_at, envelope)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::timestamptz, $10::jsonb)
         ON CONFLICT (organisation_id, id) DO NOTHING RETURNING envelope`, fuColumns(record));
      if (inserted.rows.length) return { record: read(inserted.rows[0]), created: true };
      return { record: await this.getFollowUp(record.organisationId, record.id), created: false };
    },
    async getFollowUp(organisationId, id) {
      return read((await db.query(`SELECT envelope FROM ${fu} WHERE organisation_id = $1 AND id = $2`, [organisationId, id])).rows[0]);
    },
    async listFollowUps(filter = {}) {
      const params = [filter.organisationId];
      const parts = ['organisation_id = $1'];
      const add = (sql, value) => { params.push(value); parts.push(sql.replace('?', `$${params.length}`)); };
      if (filter.userId !== undefined) { if (filter.userId === null) parts.push('user_id IS NULL'); else add('user_id = ?', filter.userId); }
      if (filter.decisionId !== undefined) add('decision_id = ?', filter.decisionId);
      if (filter.status !== undefined) add('status = ?', filter.status);
      if (filter.observableTo !== undefined) add('observable_at <= ?::timestamptz', filter.observableTo);
      params.push(limitOf(filter.limit));
      return (await db.query(`SELECT envelope FROM ${fu} WHERE ${parts.join(' AND ')} ORDER BY observable_at ASC, id ASC LIMIT $${params.length}`, params)).rows.map(read);
    },
    async updateFollowUp(organisationId, id, expectedStatus, patch) {
      const current = await this.getFollowUp(organisationId, id);
      if (!current || current.status !== expectedStatus) return null;
      const next = { ...current, ...copy(patch) };
      const result = await db.query(
        `UPDATE ${fu} SET status = $4, envelope = $5::jsonb WHERE organisation_id = $1 AND id = $2 AND status = $3 RETURNING envelope`,
        [organisationId, id, expectedStatus, next.status, JSON.stringify(next)]);
      return read(result.rows[0]);
    },
    async removeFollowUps({ organisationId, userId }) {
      const result = await db.query(`DELETE FROM ${fu} WHERE organisation_id = $1 AND user_id = $2`, [organisationId, userId]);
      return result.rowCount ?? 0;
    },
    async putCandidate(record) {
      const inserted = await db.query(
        `INSERT INTO ${ca} (organisation_id, id, agent_id, proposal_id, fingerprint, created_at, envelope)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb) ON CONFLICT (organisation_id, id) DO NOTHING RETURNING envelope`,
        [record.organisationId, record.id, record.agentId, record.proposalId, record.fingerprint, record.createdAt, JSON.stringify(record)]);
      if (inserted.rows.length) return { record: read(inserted.rows[0]), created: true };
      return { record: await this.getCandidate(record.organisationId, record.id), created: false };
    },
    async getCandidate(organisationId, id) {
      return read((await db.query(`SELECT envelope FROM ${ca} WHERE organisation_id = $1 AND id = $2`, [organisationId, id])).rows[0]);
    },
    async listCandidates(filter = {}) {
      const params = [filter.organisationId];
      const parts = ['organisation_id = $1'];
      if (filter.agentId !== undefined) { params.push(filter.agentId); parts.push(`agent_id = $${params.length}`); }
      params.push(limitOf(filter.limit));
      return (await db.query(`SELECT envelope FROM ${ca} WHERE ${parts.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`, params)).rows.map(read);
    }
  };
}

const METHODS = ['putFollowUp', 'getFollowUp', 'listFollowUps', 'updateFollowUp', 'removeFollowUps', 'putCandidate', 'getCandidate', 'listCandidates'];

module.exports = { createMemoryVigilanceStore, createPostgresVigilanceStore, postgresVigilanceSchema, VIGILANCE_STORE_METHODS: METHODS };
