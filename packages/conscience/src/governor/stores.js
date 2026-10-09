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

/**
 * Governor store kept in memory: proposals, audit journal, spending, controls.
 * Copies on every read and write; lost when the process exits.
 */
function createMemoryGovernorStore() {
  const proposals = new Map();
  const audit = [];
  const spend = new Map();
  const controls = new Map();
  return {
    async putProposal(record) {
      const key = proposalKey(record.organisationId, record.id);
      const old = proposals.get(key);
      if (old) return { record: copy(old), created: false };
      proposals.set(key, copy(record));
      return { record: copy(record), created: true };
    },
    async getProposal(organisationId, id) { return copy(proposals.get(proposalKey(organisationId, id))); },
    async transitionProposal(organisationId, id, fromStatus, patch) {
      const key = proposalKey(organisationId, id);
      const old = proposals.get(key);
      if (!old || old.status !== fromStatus) return null;
      const next = { ...old, ...copy(patch) };
      proposals.set(key, next);
      return copy(next);
    },
    async listProposals(filter = {}) {
      return [...proposals.values()]
        .filter((p) => p.organisationId === filter.organisationId && (filter.status == null || p.status === filter.status))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, boundedLimit(filter.limit)).map(copy);
    },
    async appendAudit(entry) { audit.push(copy(entry)); return copy(entry); },
    async listAudit(filter = {}) {
      return audit
        .filter((e) => (filter.organisationId === undefined || e.organisationId === filter.organisationId)
          && (filter.proposalId == null || e.proposalId === filter.proposalId))
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
    async setControl(key, value) { controls.set(key, copy(value)); return copy(value); }
  };
}

module.exports = { createMemoryGovernorStore, boundedLimit };
