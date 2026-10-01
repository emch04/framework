'use strict';

/* global structuredClone */

/**
 * Stockage en mémoire : sert aux tests et aux petits usages. Une vraie
 * application branche son propre stockage (Mongo, Postgres, SQLite…) avec la
 * même forme : get / put / remove / list pour les cartes, add / list pour le
 * journal des révisions. Tout est sérialisable (dates en ISO).
 */
function createMemorySrsStore() {
  const cards = new Map();
  const logs = [];
  const copy = (value) => (value === undefined ? value : structuredClone(value));
  return {
    async get(id) { return copy(cards.get(id)) ?? null; },
    async put(card) { cards.set(card.id, copy(card)); },
    async remove(id) { return cards.delete(id); },
    async list({ deckId } = {}) {
      return [...cards.values()].filter((card) => deckId === undefined || card.deckId === deckId).map(copy);
    },
    async addLog(entry) { logs.push(copy(entry)); },
    async listLogs({ deckId, since } = {}) {
      return logs
        .filter((entry) => (deckId === undefined || entry.deckId === deckId) && (!since || entry.reviewedAt >= since))
        .map(copy);
    }
  };
}

module.exports = { createMemorySrsStore };
