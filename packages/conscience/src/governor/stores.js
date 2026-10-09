'use strict';
const { copy } = require('./util');

const proposalKey = (organisationId, id) => `${organisationId}\u0000${id}`;
const boundedLimit = (limit, fallback = 100) => Math.min(Math.max(Number(limit) || fallback, 1), 1000);

function sumsOf(entries, entry, limits) {
  let cycle = 0; let agent = 0; let organisation = 0;
  for (const row of entries) {
    if (row.organisationId !== entry.organisationId) continue;
    if (entry.cycleId != null && row.cycleId === entry.cycleId) cycle += row.cost;
    if (row.at < limits.since) continue;
    organisation += row.cost;
    if (row.agentId === entry.agentId) agent += row.cost;
  }
  return { cycle, agent, organisation };
}

const objectKey = (organisationId, kind, id) => `${organisationId}\u0000${kind}\u0000${id}`;
const approvalCount = (record) => (Array.isArray(record.approvals) ? record.approvals.length : 0);
const decidedOrCreated = (record) => record.decidedAt ?? record.createdAt;

/**
 * Governor store kept in memory: proposals, audit journal, spending, controls.
 * Copies on every read and write; lost when the process exits.
 */
function createMemoryGovernorStore() {
  const proposals = new Map();
  const audit = [];
  const spend = new Map();
  const controls = new Map();
  const objects = new Map();
  const versions = new Map();
  const findings = new Map();
  return {
    async putProposal(record) {
      const key = proposalKey(record.organisationId, record.id);
      const old = proposals.get(key);
      if (old) return { record: copy(old), created: false };
      proposals.set(key, copy(record));
      return { record: copy(record), created: true };
    },
    async getProposal(organisationId, id) { return copy(proposals.get(proposalKey(organisationId, id))); },
    async transitionProposal(organisationId, id, fromStatus, patch, guard) {
      const key = proposalKey(organisationId, id);
      const old = proposals.get(key);
      if (!old || old.status !== fromStatus) return null;
      if (guard?.approvals !== undefined && approvalCount(old) !== guard.approvals) return null;
      const next = { ...old, ...copy(patch) };
      proposals.set(key, next);
      return copy(next);
    },
    async listProposals(filter = {}) {
      return [...proposals.values()]
        .filter((p) => p.organisationId === filter.organisationId && (filter.status == null || p.status === filter.status)
          && (filter.statuses == null || filter.statuses.includes(p.status))
          && (filter.since == null || decidedOrCreated(p) >= filter.since))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, boundedLimit(filter.limit)).map(copy);
    },
    async appendAudit(entry) { audit.push(copy(entry)); return copy(entry); },
    async listAudit(filter = {}) {
      return audit
        .filter((e) => (filter.organisationId === undefined || e.organisationId === filter.organisationId)
          && (filter.proposalId == null || e.proposalId === filter.proposalId)
          && (filter.actions == null || filter.actions.includes(e.action))
          && (filter.since == null || e.at >= filter.since)
          && (filter.objectKind == null || e.objectKind === filter.objectKind)
          && (filter.objectId == null || e.objectId === filter.objectId))
        .slice(-boundedLimit(filter.limit)).reverse().map(copy);
    },
    async reserveSpend(entry, limits) {
      const key = proposalKey(entry.organisationId, entry.id);
      const entries = [...spend.values()];
      if (spend.has(key)) return { reserved: true, created: false, totals: sumsOf(entries, entry, limits) };
      const totals = sumsOf(entries, entry, limits);
      const fits = (entry.cycleId == null || totals.cycle + entry.cost <= limits.perCycle)
        && totals.agent + entry.cost <= limits.perAgent
        && totals.organisation + entry.cost <= limits.perOrganisation;
      if (!fits) return { reserved: false, created: false, totals };
      spend.set(key, copy(entry));
      return { reserved: true, created: true, totals: sumsOf([...spend.values()], entry, limits) };
    },
    async getControl(key) { return controls.has(key) ? copy(controls.get(key)) : null; },
    async setControl(key, value) { controls.set(key, copy(value)); return copy(value); },

    async getObject(organisationId, kind, id) { return copy(objects.get(objectKey(organisationId, kind, id))); },
    async createObject(state) {
      const key = objectKey(state.organisationId, state.kind, state.id);
      if (objects.has(key)) return { record: copy(objects.get(key)), created: false };
      objects.set(key, copy(state));
      return { record: copy(state), created: true };
    },
    async updateObject(organisationId, kind, id, expectedRevision, next) {
      const key = objectKey(organisationId, kind, id);
      const old = objects.get(key);
      if (!old || old.revision !== expectedRevision) return null;
      objects.set(key, copy(next));
      return copy(next);
    },
    async listObjects(filter = {}) {
      return [...objects.values()]
        .filter((o) => (filter.organisationId == null || o.organisationId === filter.organisationId)
          && (filter.kind == null || o.kind === filter.kind) && (!filter.hasCandidate || o.candidate != null))
        .sort((a, b) => (objectKey(a.organisationId, a.kind, a.id) < objectKey(b.organisationId, b.kind, b.id) ? -1 : 1))
        .slice(0, boundedLimit(filter.limit)).map(copy);
    },
    async putVersion(record) {
      const key = `${objectKey(record.organisationId, record.kind, record.id)}\u0000${record.versionId}`;
      if (versions.has(key)) return { record: copy(versions.get(key)), created: false };
      versions.set(key, copy(record));
      return { record: copy(record), created: true };
    },
    async getVersion(organisationId, kind, id, versionId) { return copy(versions.get(`${objectKey(organisationId, kind, id)}\u0000${versionId}`)); },
    async listVersions(filter) {
      return [...versions.values()]
        .filter((v) => v.organisationId === filter.organisationId && v.kind === filter.kind && v.id === filter.id)
        .sort((a, b) => a.number - b.number).slice(0, boundedLimit(filter.limit, 1000)).map(copy);
    },

    async putFinding(record) {
      const key = proposalKey(record.organisationId, record.id);
      if (findings.has(key)) return { record: copy(findings.get(key)), created: false };
      findings.set(key, copy(record));
      return { record: copy(record), created: true };
    },
    async listFindings(filter = {}) {
      return [...findings.values()]
        .filter((f) => f.organisationId === filter.organisationId && (filter.since == null || f.receivedAt >= filter.since) && (filter.until == null || f.receivedAt <= filter.until))
        .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : a.id < b.id ? -1 : 1))
        .slice(0, boundedLimit(filter.limit)).map(copy);
    }
  };
}

module.exports = { createMemoryGovernorStore, boundedLimit };
