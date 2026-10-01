/**
 * Stockage en mémoire, par défaut. Il sert aux tests, aux démonstrations et
 * aux petits outils ; il implémente exactement le même contrat que
 * l'adaptateur Postgres (voir index.d.ts, `LedgerStore`).
 *
 * Deux garanties comptent pour la comptabilité :
 * - une transaction est tout ou rien : en cas d'erreur, l'état d'avant est
 *   restauré, donc pas de numéro consommé sans écriture ;
 * - les transactions d'une même entité passent l'une après l'autre (verrou),
 *   donc deux validations simultanées ne prennent jamais le même numéro.
 * Tout ce qui entre ou sort est copié : modifier un objet rendu ne modifie
 * jamais la donnée stockée.
 */

/* global structuredClone */

function copie(valeur) {
  return valeur === undefined ? undefined : structuredClone(valeur);
}

function etatVide() {
  return {
    accounts: new Map(),
    partners: new Map(),
    journals: new Map(),
    fiscalYears: new Map(),
    entries: new Map(),
    sequences: new Map(),
    matchings: new Map(),
    statementLines: new Map(),
    compteur: { suivant: 1 }
  };
}

function filtrerEcritures(ecritures, filtre = {}) {
  return ecritures.filter((e) => (!filtre.status || e.status === filtre.status)
    && (!filtre.journal || e.journal === filtre.journal)
    && (!filtre.fiscalYear || e.fiscalYear === filtre.fiscalYear)
    && (!filtre.from || e.date >= filtre.from)
    && (!filtre.to || e.date <= filtre.to)
    && (!filtre.reverses || e.reverses === filtre.reverses));
}

/** Copie d'une écriture sans son rang de création interne. */
function sansOrdre(ecriture) {
  const resultat = copie(ecriture);
  delete resultat.createdSeq;
  return resultat;
}

function trierEcritures(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return (a.createdSeq || 0) - (b.createdSeq || 0);
}

function acces(etat) {
  return {
    async getAccount(code) { return copie(etat.accounts.get(code)) || null; },
    async listAccounts() { return copie([...etat.accounts.values()]); },
    async insertAccount(compte) { etat.accounts.set(compte.code, copie(compte)); },

    async getPartner(id) { return copie(etat.partners.get(id)) || null; },
    async listPartners() { return copie([...etat.partners.values()]); },
    async insertPartner(tiers) { etat.partners.set(tiers.id, copie(tiers)); },

    async getJournal(code) { return copie(etat.journals.get(code)) || null; },
    async listJournals() { return copie([...etat.journals.values()]); },
    async insertJournal(journal) { etat.journals.set(journal.code, copie(journal)); },

    async listFiscalYears() {
      return copie([...etat.fiscalYears.values()].sort((a, b) => (a.start < b.start ? -1 : 1)));
    },
    async insertFiscalYear(exercice) { etat.fiscalYears.set(exercice.code, copie(exercice)); },
    async updateFiscalYear(code, modification) {
      const exercice = etat.fiscalYears.get(code);
      if (!exercice) return false;
      etat.fiscalYears.set(code, { ...exercice, ...copie(modification) });
      return true;
    },

    async insertEntry(ecriture) {
      etat.entries.set(ecriture.id, { ...copie(ecriture), createdSeq: etat.compteur.suivant });
      etat.compteur.suivant += 1;
    },
    async getEntry(id) {
      const ecriture = etat.entries.get(id);
      return ecriture ? sansOrdre(ecriture) : null;
    },
    async listEntries(filtre) {
      return filtrerEcritures([...etat.entries.values()], filtre)
        .sort(trierEcritures)
        .map(sansOrdre);
    },
    async replaceDraft(id, ecriture) {
      const actuelle = etat.entries.get(id);
      if (!actuelle || actuelle.status !== 'draft') return false;
      etat.entries.set(id, { ...copie(ecriture), createdSeq: actuelle.createdSeq });
      return true;
    },
    async deleteDraft(id) {
      const actuelle = etat.entries.get(id);
      if (!actuelle || actuelle.status !== 'draft') return false;
      etat.entries.delete(id);
      return true;
    },
    async markPosted(id, validation) {
      const actuelle = etat.entries.get(id);
      if (!actuelle || actuelle.status !== 'draft') return false;
      etat.entries.set(id, { ...actuelle, ...copie(validation), status: 'posted' });
      return true;
    },

    async getSequence(journal, exercice) {
      return copie(etat.sequences.get(`${journal}|${exercice}`)) || null;
    },
    async setSequence(journal, exercice, sequence) {
      etat.sequences.set(`${journal}|${exercice}`, copie(sequence));
    },

    async insertMatching(lettrage) { etat.matchings.set(lettrage.code, copie(lettrage)); },
    async deleteMatching(code) { return etat.matchings.delete(code); },
    async listMatchings(filtre = {}) {
      return copie([...etat.matchings.values()].filter((m) => (!filtre.account || m.account === filtre.account)
        && (!filtre.lineId || m.lineIds.includes(filtre.lineId))));
    },

    async insertStatementLines(lignes) {
      for (const ligne of lignes) etat.statementLines.set(ligne.id, copie(ligne));
    },
    async listStatementLines(filtre = {}) {
      return copie([...etat.statementLines.values()]
        .filter((l) => !filtre.account || l.account === filtre.account)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
    },
    async updateStatementLine(id, modification) {
      const ligne = etat.statementLines.get(id);
      if (!ligne) return false;
      etat.statementLines.set(id, { ...ligne, ...copie(modification) });
      return true;
    }
  };
}

function createMemoryLedgerStore() {
  const entites = new Map();
  const verrous = new Map();

  function etatDe(entite) {
    if (!entites.has(entite)) entites.set(entite, etatVide());
    return entites.get(entite);
  }

  /** Exécute `travail` après le précédent de la même entité. */
  function enFile(entite, travail) {
    const precedent = verrous.get(entite) || Promise.resolve();
    const suivant = precedent.then(travail, travail);
    verrous.set(entite, suivant.catch(() => {}));
    return suivant;
  }

  return {
    kind: 'memory',
    transaction(entite, fn) {
      return enFile(entite, async () => {
        const avant = etatDe(entite);
        const brouillon = {};
        for (const [cle, valeur] of Object.entries(avant)) brouillon[cle] = structuredClone(valeur);
        const resultat = await fn(acces(brouillon));
        entites.set(entite, brouillon);
        return resultat;
      });
    },
    read(entite, fn) {
      return enFile(entite, () => fn(acces(etatDe(entite))));
    }
  };
}

module.exports = { createMemoryLedgerStore };
