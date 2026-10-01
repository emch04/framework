/**
 * Moteur de comptabilité en partie double.
 *
 * Règles tenues par le moteur, quel que soit le stockage :
 * - une écriture a au moins deux lignes et elle est équilibrée (total débit =
 *   total crédit), dans sa devise ET dans la devise de tenue ; sinon refus ;
 * - les montants sont des entiers en plus petite unité ;
 * - une écriture naît brouillon (proposée, par un humain, l'IA ou un
 *   système) et devient validée seulement par un humain ; validée, elle ne
 *   change plus jamais : on la corrige par contre-passation ;
 * - le numéro est donné à la validation, par journal et par exercice, sans
 *   trou, et dans l'ordre des dates ;
 * - un exercice clôturé n'accepte plus rien ; la clôture solde les comptes de
 *   gestion dans le résultat et reporte les comptes de bilan à nouveau.
 */
const { randomUUID } = require('crypto');
const { LedgerError, createCurrencies, createRateTable, convertir, lireTaux, somme, verifierDate, verifierMontant } = require('./money');
const { loadChart, verifierCompte } = require('./charts');
const { layoutsFor } = require('./layouts');
const reports = require('./reports');
const { createMemoryLedgerStore } = require('./memoryStore');

const TYPES_JOURNAL = Object.freeze(['purchase', 'sale', 'bank', 'cash', 'general', 'opening']);
const NATURES_ACTEUR = Object.freeze(['human', 'ai', 'system']);

function lettres(n) {
  let texte = '';
  let reste = n;
  while (reste > 0) {
    const r = (reste - 1) % 26;
    texte = String.fromCharCode(65 + r) + texte;
    reste = Math.floor((reste - 1) / 26);
  }
  return texte;
}

function verifierActeur(acteur) {
  if (!acteur || typeof acteur.id !== 'string' || !acteur.id || !NATURES_ACTEUR.includes(acteur.kind)) {
    throw new LedgerError('INVALID_ACTOR', `Acteur requis : { id, kind } avec kind parmi ${NATURES_ACTEUR.join(', ')}.`);
  }
  return { id: acteur.id, kind: acteur.kind, ...(acteur.name ? { name: acteur.name } : {}) };
}

function exigerHumain(acteur, action) {
  const a = verifierActeur(acteur);
  if (a.kind !== 'human') {
    throw new LedgerError('HUMAN_VALIDATION_REQUIRED', `${action} : seul un humain peut le faire (acteur ${a.kind}). L'IA propose, un humain valide.`);
  }
  return a;
}

function journauxParDefaut(profil) {
  return [
    { code: 'AC', type: 'purchase', name: 'Achats' },
    { code: 'VT', type: 'sale', name: 'Ventes' },
    { code: 'CA', type: 'cash', name: 'Caisse', account: profil.cash },
    { code: 'OD', type: 'general', name: 'Opérations diverses' },
    { code: 'AN', type: 'opening', name: 'À-nouveaux' }
  ];
}

function separerLigne(idLigne) {
  const position = typeof idLigne === 'string' ? idLigne.lastIndexOf('#') : -1;
  if (position <= 0) throw new LedgerError('INVALID_LINE', `Référence de ligne invalide : ${idLigne}.`);
  return { entryId: idLigne.slice(0, position) };
}

/**
 * Crée un grand livre pour UNE entité (société, association, école…).
 */
function createLedger(options = {}) {
  const entite = options.entity || {};
  if (typeof entite.id !== 'string' || !entite.id) throw new LedgerError('INVALID_ENTITY', 'entity.id est requis.');
  const plan = typeof entite.chart === 'string' || entite.chart === undefined ? loadChart(entite.chart || 'syscohada') : entite.chart;
  if (!plan || !Array.isArray(plan.accounts) || !plan.profile) {
    throw new LedgerError('UNKNOWN_CHART', 'entity.chart : un plan livré (syscohada, syscebnl) ou un objet createChart().');
  }
  const devises = createCurrencies(options.currencies);
  const devise = entite.currency || 'CDF';
  devises.decimals(devise);
  const taux = options.rates || createRateTable();
  const store = options.store || createMemoryLedgerStore();
  const hooks = options.hooks || {};
  const maintenant = options.now || (() => new Date());
  const profil = plan.profile;
  const comptesDuPlan = new Map(plan.accounts.map((c) => [c.code, c]));
  const presentations = layoutsFor(plan);
  const journauxDefaut = new Map(journauxParDefaut(profil).map((j) => [j.code, j]));

  const horodatage = () => maintenant().toISOString();
  const ecrire = (fn) => store.transaction(entite.id, fn);
  const lire = (fn) => store.read(entite.id, fn);

  async function compte(tx, code) {
    const trouve = comptesDuPlan.get(code) || await tx.getAccount(code);
    if (!trouve) throw new LedgerError('UNKNOWN_ACCOUNT', `Compte inconnu : ${code}. Ajoute-le avec addAccount() s'il manque au plan.`);
    return trouve;
  }

  async function journal(tx, code) {
    const trouve = journauxDefaut.get(code) || await tx.getJournal(code);
    if (!trouve) throw new LedgerError('UNKNOWN_JOURNAL', `Journal inconnu : ${code}.`);
    return trouve;
  }

  async function exerciceOuvert(tx, date) {
    const exercices = await tx.listFiscalYears();
    const exercice = exercices.find((e) => e.start <= date && date <= e.end);
    if (!exercice) throw new LedgerError('NO_FISCAL_YEAR', `Aucun exercice ne couvre le ${date}. Ouvre-le avec openFiscalYear().`);
    if (exercice.status !== 'open') throw new LedgerError('FISCAL_YEAR_CLOSED', `L'exercice ${exercice.code} est clôturé : plus aucune écriture au ${date}.`);
    return exercice;
  }

  /** Arrondis de conversion : l'écart va sur la plus grosse ligne du côté le plus faible. */
  function equilibrerConversion(lignes) {
    const ecart = somme(lignes.map((l) => l.debit)) - somme(lignes.map((l) => l.credit));
    if (ecart === 0) return 0;
    const cote = ecart > 0 ? 'credit' : 'debit';
    // La plus grosse ligne de ce côté en devise d'origine : elle existe
    // toujours, même si sa conversion a donné zéro.
    const duCote = (l) => (cote === 'debit' ? l.amountCurrency > 0 : l.amountCurrency < 0);
    const cible = lignes.filter(duCote).sort((a, b) => Math.abs(b.amountCurrency) - Math.abs(a.amountCurrency))[0];
    cible[cote] += Math.abs(ecart);
    return ecart;
  }

  /** Transforme une saisie en écriture brouillon vérifiée. */
  async function preparer(tx, saisie, id) {
    if (!saisie || typeof saisie !== 'object') throw new LedgerError('INVALID_ENTRY', 'Écriture attendue.');
    const j = await journal(tx, saisie.journal);
    if (j.type === 'opening') throw new LedgerError('RESERVED_JOURNAL', 'Le journal des à-nouveaux est réservé à la clôture.');
    verifierDate(saisie.date);
    const exercice = await exerciceOuvert(tx, saisie.date);
    const monnaie = saisie.currency || devise;
    devises.decimals(monnaie);
    let fraction = { num: 1n, den: 1n };
    let infoTaux = null;
    if (monnaie !== devise) {
      if (saisie.rate !== undefined) {
        fraction = lireTaux(saisie.rate);
        infoTaux = { value: String(saisie.rate), date: saisie.date, source: 'manual' };
      } else {
        const t = await taux.rateAt(monnaie, devise, saisie.date);
        fraction = t;
        infoTaux = { value: `${t.num}/${t.den}`, date: t.date, source: 'table', ...(t.inverted ? { inverted: true } : {}) };
      }
    }
    if (!Array.isArray(saisie.lines) || saisie.lines.length < 2) {
      throw new LedgerError('INVALID_ENTRY', 'Une écriture a au moins deux lignes.');
    }
    const lignes = [];
    for (const [index, brute] of saisie.lines.entries()) {
      const debit = brute.debit === undefined ? 0 : verifierMontant(brute.debit, `lignes[${index}].debit`);
      const credit = brute.credit === undefined ? 0 : verifierMontant(brute.credit, `lignes[${index}].credit`);
      if (debit < 0 || credit < 0) throw new LedgerError('INVALID_AMOUNT', `Ligne ${index + 1} : montant négatif interdit, utilise l'autre colonne.`);
      if ((debit === 0) === (credit === 0)) {
        throw new LedgerError('INVALID_LINE', `Ligne ${index + 1} : un débit OU un crédit, non nul.`);
      }
      const c = await compte(tx, brute.account);
      if (brute.partner !== undefined && brute.partner !== null && !(await tx.getPartner(brute.partner))) {
        throw new LedgerError('UNKNOWN_PARTNER', `Tiers inconnu : ${brute.partner}.`);
      }
      const ligne = {
        account: c.code,
        label: brute.label || saisie.label || '',
        debit: convertir(debit, fraction, devises.decimals(monnaie), devises.decimals(devise)),
        credit: convertir(credit, fraction, devises.decimals(monnaie), devises.decimals(devise)),
        currency: monnaie,
        amountCurrency: debit - credit
      };
      if (brute.partner) ligne.partner = brute.partner;
      if (brute.tax) ligne.tax = { code: String(brute.tax.code), base: verifierMontant(brute.tax.base || 0, 'tax.base') };
      lignes.push(ligne);
    }
    const totalDebit = somme(saisie.lines.map((l) => l.debit || 0));
    const totalCredit = somme(saisie.lines.map((l) => l.credit || 0));
    if (totalDebit !== totalCredit) {
      throw new LedgerError('UNBALANCED_ENTRY', `Écriture déséquilibrée : débit ${totalDebit} ≠ crédit ${totalCredit} (écart ${totalDebit - totalCredit}).`, {
        debit: totalDebit, credit: totalCredit, difference: totalDebit - totalCredit
      });
    }
    const arrondi = equilibrerConversion(lignes);
    const ecritureId = id || randomUUID();
    lignes.forEach((ligne, index) => { ligne.id = `${ecritureId}#${index + 1}`; });
    return {
      id: ecritureId,
      entity: entite.id,
      journal: j.code,
      fiscalYear: exercice.code,
      date: saisie.date,
      label: saisie.label || '',
      ...(saisie.reference ? { reference: String(saisie.reference) } : {}),
      currency: monnaie,
      ...(infoTaux ? { rate: infoTaux } : {}),
      ...(arrondi ? { conversionRounding: arrondi } : {}),
      lines: lignes,
      totals: { debit: somme(lignes.map((l) => l.debit)), credit: somme(lignes.map((l) => l.credit)) },
      ...(saisie.meta ? { meta: saisie.meta } : {}),
      status: 'draft',
      number: null
    };
  }

  /** Validation dans une transaction ouverte : numéro, chronologie, statut. */
  async function valider(tx, id, acteur) {
    const ecriture = await tx.getEntry(id);
    if (!ecriture) throw new LedgerError('ENTRY_NOT_FOUND', `Écriture introuvable : ${id}.`);
    if (ecriture.status !== 'draft') throw new LedgerError('ENTRY_IMMUTABLE', `L'écriture ${ecriture.number} est déjà validée : elle ne change plus.`);
    const exercice = await exerciceOuvert(tx, ecriture.date);
    if (exercice.code !== ecriture.fiscalYear) throw new LedgerError('INVALID_ENTRY', "La date de l'écriture ne correspond plus à son exercice.");
    if (somme(ecriture.lines.map((l) => l.debit)) !== somme(ecriture.lines.map((l) => l.credit))) {
      throw new LedgerError('UNBALANCED_ENTRY', 'Écriture déséquilibrée en devise de tenue.');
    }
    if (hooks.beforeValidate) await hooks.beforeValidate(ecriture, acteur);
    const sequence = (await tx.getSequence(ecriture.journal, ecriture.fiscalYear)) || { last: 0, lastDate: null };
    if (sequence.lastDate && ecriture.date < sequence.lastDate) {
      throw new LedgerError('CHRONOLOGY', `Le journal ${ecriture.journal} a déjà une écriture validée au ${sequence.lastDate} : impossible de valider au ${ecriture.date}.`);
    }
    const rang = sequence.last + 1;
    const validation = {
      number: `${ecriture.journal}-${ecriture.fiscalYear}-${String(rang).padStart(6, '0')}`,
      sequence: rang,
      postedAt: horodatage(),
      postedBy: acteur
    };
    await tx.setSequence(ecriture.journal, ecriture.fiscalYear, { last: rang, lastDate: ecriture.date });
    if (!(await tx.markPosted(id, validation))) throw new LedgerError('ENTRY_IMMUTABLE', `L'écriture ${id} n'est plus un brouillon.`);
    return { ...ecriture, ...validation, status: 'posted' };
  }

  /** Écriture construite par le moteur (clôture, à-nouveaux, écart de change). */
  async function inscrireSysteme(tx, { journal: code, date, label, lines, meta, reverses }, acteur) {
    const j = await journal(tx, code);
    const exercice = await exerciceOuvert(tx, date);
    const id = randomUUID();
    const lignes = lines.map((ligne, index) => ({ ...ligne, id: `${id}#${index + 1}` }));
    const ecriture = {
      id,
      entity: entite.id,
      journal: j.code,
      fiscalYear: exercice.code,
      date,
      label,
      currency: devise,
      lines: lignes,
      totals: { debit: somme(lignes.map((l) => l.debit)), credit: somme(lignes.map((l) => l.credit)) },
      ...(meta ? { meta } : {}),
      ...(reverses ? { reverses } : {}),
      status: 'draft',
      number: null,
      proposedBy: acteur,
      createdAt: horodatage()
    };
    if (ecriture.totals.debit !== ecriture.totals.credit) throw new LedgerError('UNBALANCED_ENTRY', `${label} : écriture déséquilibrée.`);
    await tx.insertEntry(ecriture);
    return valider(tx, id, acteur);
  }

  async function lignesParId(tx, ids) {
    const cache = new Map();
    const resultat = [];
    for (const idLigne of ids) {
      const { entryId } = separerLigne(idLigne);
      if (!cache.has(entryId)) cache.set(entryId, await tx.getEntry(entryId));
      const ecriture = cache.get(entryId);
      const ligne = ecriture && ecriture.lines.find((l) => l.id === idLigne);
      if (!ligne) throw new LedgerError('LINE_NOT_FOUND', `Ligne introuvable : ${idLigne}.`);
      if (ecriture.status !== 'posted') throw new LedgerError('ENTRY_NOT_POSTED', `La ligne ${idLigne} appartient à un brouillon.`);
      resultat.push({ ...ligne, date: ecriture.date, entryId: ecriture.id, number: ecriture.number });
    }
    return resultat;
  }

  async function ecrituresValidees(tx, filtre = {}) {
    return tx.listEntries({ ...filtre, status: 'posted' });
  }

  /** Lignes reprises en à-nouveaux : leur suite se lettre sur la ligne reportée. */
  async function lignesReportees(tx) {
    const reportees = new Set();
    for (const e of await ecrituresValidees(tx, { journal: 'AN' })) {
      for (const l of e.lines) for (const idL of l.carriedFrom || []) reportees.add(idL);
    }
    return reportees;
  }

  async function exercicePour(tx, { fiscalYear, to }) {
    const exercices = await tx.listFiscalYears();
    if (!exercices.length) throw new LedgerError('NO_FISCAL_YEAR', 'Aucun exercice ouvert.');
    if (fiscalYear) {
      const e = exercices.find((x) => x.code === fiscalYear);
      if (!e) throw new LedgerError('NO_FISCAL_YEAR', `Exercice inconnu : ${fiscalYear}.`);
      return e;
    }
    if (to) {
      const e = exercices.find((x) => x.start <= to && to <= x.end);
      if (!e) throw new LedgerError('NO_FISCAL_YEAR', `Aucun exercice ne couvre le ${to}.`);
      return e;
    }
    return exercices[exercices.length - 1];
  }

  /**
   * Périmètre d'un état : à-nouveaux et écritures antérieures à `from` dans
   * l'exercice (ouverture), puis écritures de la période. L'écriture de
   * clôture est exclue par défaut : les états montrent l'exercice avant sa
   * remise à zéro.
   */
  async function perimetre(tx, opts = {}) {
    const exercice = await exercicePour(tx, opts);
    const debut = opts.from || exercice.start;
    const fin = opts.to || exercice.end;
    verifierDate(debut, 'from');
    verifierDate(fin, 'to');
    const toutes = (await ecrituresValidees(tx, { fiscalYear: exercice.code }))
      .filter((e) => opts.includeClosing || !(e.meta && e.meta.kind === 'closing'));
    const ouverture = [];
    const periode = [];
    for (const e of toutes) {
      const estOuverture = e.meta && e.meta.kind === 'opening';
      if (estOuverture || e.date < debut) ouverture.push(e);
      else if (e.date <= fin) periode.push(e);
    }
    return { exercice, debut, fin, ouverture, periode };
  }

  async function decrireDepuis(tx) {
    const perso = new Map((await tx.listAccounts()).map((c) => [c.code, c]));
    return (code) => comptesDuPlan.get(code) || perso.get(code) || { code, name: code, class: Number(code[0]) };
  }

  async function prochainesLettres(tx, codeCompte) {
    const sequence = (await tx.getSequence(`lettrage:${codeCompte}`, '*')) || { last: 0, lastDate: null };
    await tx.setSequence(`lettrage:${codeCompte}`, '*', { last: sequence.last + 1, lastDate: null });
    return lettres(sequence.last + 1);
  }

  const ledger = {
    entity: Object.freeze({ id: entite.id, currency: devise, chart: plan.id }),
    chart: plan,
    currencies: devises,

    // ——— Comptes, tiers, journaux ———

    async getAccount(code) {
      return lire((tx) => compte(tx, code));
    },

    async listAccounts({ class: classe } = {}) {
      return lire(async (tx) => {
        const tous = [...plan.accounts, ...(await tx.listAccounts())].sort((a, b) => (a.code < b.code ? -1 : 1));
        return classe ? tous.filter((c) => c.class === classe) : tous;
      });
    },

    /** Ajoute un compte au plan de l'entité (ex. 5211 « Banque Equity BCDC »). */
    async addAccount({ code, name, type = null, reconcile = false }) {
      const c = verifierCompte({ code, name, type, reconcile, custom: true });
      return ecrire(async (tx) => {
        if (comptesDuPlan.has(c.code) || await tx.getAccount(c.code)) {
          throw new LedgerError('DUPLICATE_ACCOUNT', `Le compte ${c.code} existe déjà.`);
        }
        await tx.insertAccount({ ...c });
        return c;
      });
    },

    /** Tiers (compte auxiliaire) : client, fournisseur, adhérent, salarié… */
    async addPartner({ id, name, kind = 'other', account }) {
      if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) {
        throw new LedgerError('INVALID_PARTNER', 'Un tiers a un id et un nom.');
      }
      return ecrire(async (tx) => {
        if (await tx.getPartner(id)) throw new LedgerError('DUPLICATE_PARTNER', `Le tiers ${id} existe déjà.`);
        const collectif = account || (kind === 'customer' ? profil.receivable : kind === 'supplier' ? profil.payable : null);
        if (collectif) await compte(tx, collectif);
        const tiers = { id, name, kind, ...(collectif ? { account: collectif } : {}) };
        await tx.insertPartner(tiers);
        return tiers;
      });
    },

    async getPartner(id) {
      return lire((tx) => tx.getPartner(id));
    },

    async listPartners() {
      return lire((tx) => tx.listPartners());
    },

    async addJournal({ code, type, name, account }) {
      if (typeof code !== 'string' || !/^[A-Z0-9]{1,8}$/.test(code)) {
        throw new LedgerError('INVALID_JOURNAL', 'Code journal : 1 à 8 caractères, majuscules et chiffres.');
      }
      if (!TYPES_JOURNAL.includes(type) || type === 'opening') {
        throw new LedgerError('INVALID_JOURNAL', `Type de journal : ${TYPES_JOURNAL.filter((t) => t !== 'opening').join(', ')}.`);
      }
      if ((type === 'bank' || type === 'cash') && !account) {
        throw new LedgerError('INVALID_JOURNAL', 'Un journal de banque ou de caisse a son compte de trésorerie.');
      }
      return ecrire(async (tx) => {
        if (journauxDefaut.has(code) || await tx.getJournal(code)) throw new LedgerError('DUPLICATE_JOURNAL', `Le journal ${code} existe déjà.`);
        if (account) {
          const c = await compte(tx, account);
          if (c.class !== 5) throw new LedgerError('INVALID_JOURNAL', `Le compte ${account} n'est pas un compte de trésorerie (classe 5).`);
        }
        const j = { code, type, name: name || code, ...(account ? { account } : {}) };
        await tx.insertJournal(j);
        return j;
      });
    },

    async listJournals() {
      return lire(async (tx) => [...journauxDefaut.values(), ...(await tx.listJournals())]);
    },

    // ——— Exercices ———

    async openFiscalYear({ code, start, end }) {
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(code)) {
        throw new LedgerError('INVALID_FISCAL_YEAR', "Code d'exercice : lettres, chiffres, - et _ (ex. 2026).");
      }
      verifierDate(start, 'start');
      verifierDate(end, 'end');
      if (end < start) throw new LedgerError('INVALID_FISCAL_YEAR', "La fin de l'exercice précède son début.");
      return ecrire(async (tx) => {
        const exercices = await tx.listFiscalYears();
        if (exercices.some((e) => e.code === code)) throw new LedgerError('DUPLICATE_FISCAL_YEAR', `L'exercice ${code} existe déjà.`);
        const chevauche = exercices.find((e) => !(end < e.start || start > e.end));
        if (chevauche) throw new LedgerError('OVERLAPPING_FISCAL_YEAR', `Chevauche l'exercice ${chevauche.code} (${chevauche.start} → ${chevauche.end}).`);
        const exercice = { code, start, end, status: 'open' };
        await tx.insertFiscalYear(exercice);
        return exercice;
      });
    },

    async listFiscalYears() {
      return lire((tx) => tx.listFiscalYears());
    },

    /**
     * Clôture : solde les classes 6, 7 et 8 dans le résultat (131 bénéfice /
     * 139 perte) par une écriture au dernier jour, verrouille l'exercice, puis
     * reporte les classes 1 à 5 dans l'exercice suivant (journal AN). Les
     * comptes lettrables sont reportés ligne à ligne (pièces non lettrées)
     * pour que le lettrage continue ; les autres en un solde par compte,
     * tiers et devise. `allocateResult` affecte le résultat en report à
     * nouveau dès l'ouverture (121 / 1291 en SYSCOHADA, 121 / 129 en SYSCEBNL).
     */
    async closeFiscalYear(code, { actor, next, allocateResult = false, carryForward = true, closingJournal = 'OD' } = {}) {
      const acteur = exigerHumain(actor, "Clôturer l'exercice");
      const bilan = await ecrire(async (tx) => {
        const exercices = await tx.listFiscalYears();
        const exercice = exercices.find((e) => e.code === code);
        if (!exercice) throw new LedgerError('NO_FISCAL_YEAR', `Exercice inconnu : ${code}.`);
        if (exercice.status !== 'open') throw new LedgerError('FISCAL_YEAR_CLOSED', `L'exercice ${code} est déjà clôturé.`);
        const brouillons = await tx.listEntries({ fiscalYear: code, status: 'draft' });
        if (brouillons.length) {
          throw new LedgerError('DRAFTS_PENDING', `${brouillons.length} brouillon(s) dans l'exercice ${code} : valide-les ou supprime-les avant la clôture.`, {
            drafts: brouillons.map((b) => b.id)
          });
        }
        let suivant = null;
        if (carryForward) {
          suivant = next
            ? exercices.find((e) => e.code === next)
            : exercices.find((e) => e.start > exercice.end);
          if (!suivant) throw new LedgerError('NEXT_FISCAL_YEAR_REQUIRED', `Ouvre l'exercice suivant avant de clôturer ${code} (ou passe carryForward: false).`);
          if (suivant.status !== 'open') throw new LedgerError('FISCAL_YEAR_CLOSED', `L'exercice suivant ${suivant.code} est clôturé.`);
        }

        const ecritures = await ecrituresValidees(tx, { fiscalYear: code });
        const nets = reports.soldes(ecritures);
        const lignesCloture = [];
        let resultat = 0;
        for (const [codeCompte, net] of [...nets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          const classe = Number(codeCompte[0]);
          if (classe < 6 || classe > 8 || net === 0) continue;
          resultat -= net;
          lignesCloture.push({
            account: codeCompte,
            label: `Clôture ${code}`,
            debit: net < 0 ? -net : 0,
            credit: net > 0 ? net : 0,
            currency: devise,
            amountCurrency: -net
          });
        }
        let cloture = null;
        if (lignesCloture.length) {
          const compteResultat = resultat >= 0 ? profil.resultProfit : profil.resultLoss;
          await compte(tx, compteResultat);
          if (resultat !== 0) {
            lignesCloture.push({
              account: compteResultat,
              label: `Résultat de l'exercice ${code}`,
              debit: resultat < 0 ? -resultat : 0,
              credit: resultat > 0 ? resultat : 0,
              currency: devise,
              amountCurrency: -resultat
            });
          }
          cloture = await inscrireSysteme(tx, {
            journal: closingJournal,
            date: exercice.end,
            label: `Clôture de l'exercice ${code}`,
            lines: lignesCloture,
            meta: { kind: 'closing', fiscalYear: code }
          }, acteur);
        }

        await tx.updateFiscalYear(code, { status: 'closed', closedAt: horodatage(), closedBy: acteur, result: resultat });

        let ouverture = null;
        if (suivant) {
          const apres = cloture ? [...ecritures, cloture] : ecritures;
          const lignes = await lignesANouveau(tx, apres, code);
          if (allocateResult) {
            for (const ligne of lignes) {
              if (ligne.account === profil.resultProfit) ligne.account = profil.retainedProfit;
              else if (ligne.account === profil.resultLoss) ligne.account = profil.retainedLoss;
            }
            for (const ligne of lignes) await compte(tx, ligne.account);
          }
          if (lignes.length) {
            ouverture = await inscrireSysteme(tx, {
              journal: 'AN',
              date: suivant.start,
              label: `À-nouveaux de l'exercice ${code}`,
              lines: lignes,
              meta: { kind: 'opening', from: code }
            }, acteur);
          }
        }
        return { fiscalYear: code, result: resultat, closingEntry: cloture, openingEntry: ouverture, next: suivant ? suivant.code : null };
      });
      if (hooks.afterClose) await hooks.afterClose(bilan, acteur);
      return bilan;
    },

    // ——— Écritures ———

    /** Propose une écriture (brouillon). C'est l'entrée de l'IA et des modules. */
    async propose(saisie, { actor } = {}) {
      const acteur = verifierActeur(actor);
      const ecriture = await ecrire(async (tx) => {
        const e = await preparer(tx, saisie);
        const brouillon = { ...e, proposedBy: acteur, createdAt: horodatage(), ...(saisie.rationale ? { rationale: String(saisie.rationale) } : {}) };
        await tx.insertEntry(brouillon);
        return brouillon;
      });
      if (hooks.onProposal) await hooks.onProposal(ecriture, acteur);
      return ecriture;
    },

    async updateDraft(id, saisie, { actor } = {}) {
      const acteur = verifierActeur(actor);
      return ecrire(async (tx) => {
        const actuelle = await tx.getEntry(id);
        if (!actuelle) throw new LedgerError('ENTRY_NOT_FOUND', `Écriture introuvable : ${id}.`);
        if (actuelle.status !== 'draft') throw new LedgerError('ENTRY_IMMUTABLE', `L'écriture ${actuelle.number} est validée : corrige-la par contre-passation.`);
        const e = await preparer(tx, saisie, id);
        const brouillon = {
          ...e,
          proposedBy: actuelle.proposedBy,
          createdAt: actuelle.createdAt,
          updatedBy: acteur,
          updatedAt: horodatage(),
          ...(saisie.rationale ? { rationale: String(saisie.rationale) } : {})
        };
        if (!(await tx.replaceDraft(id, brouillon))) throw new LedgerError('ENTRY_IMMUTABLE', `L'écriture ${id} n'est plus un brouillon.`);
        return brouillon;
      });
    },

    async discardDraft(id, { actor } = {}) {
      verifierActeur(actor);
      return ecrire(async (tx) => {
        const actuelle = await tx.getEntry(id);
        if (!actuelle) throw new LedgerError('ENTRY_NOT_FOUND', `Écriture introuvable : ${id}.`);
        if (actuelle.status !== 'draft' || !(await tx.deleteDraft(id))) {
          throw new LedgerError('ENTRY_IMMUTABLE', 'Une écriture validée ne se supprime pas : contre-passe-la.');
        }
        return true;
      });
    },

    /** Valide un brouillon : réservé à un humain. */
    async validate(id, { actor } = {}) {
      const acteur = exigerHumain(actor, 'Valider une écriture');
      const ecriture = await ecrire((tx) => valider(tx, id, acteur));
      if (hooks.afterValidate) await hooks.afterValidate(ecriture, acteur);
      return ecriture;
    },

    /** Saisie directe par un humain : brouillon et validation dans la même transaction. */
    async post(saisie, { actor } = {}) {
      const acteur = exigerHumain(actor, 'Passer une écriture');
      const ecriture = await ecrire(async (tx) => {
        const e = await preparer(tx, saisie);
        await tx.insertEntry({ ...e, proposedBy: acteur, createdAt: horodatage() });
        return valider(tx, e.id, acteur);
      });
      if (hooks.afterValidate) await hooks.afterValidate(ecriture, acteur);
      return ecriture;
    },

    /**
     * Contre-passation : écriture miroir (débits et crédits inversés), validée,
     * liée à l'originale. L'originale reste intacte.
     */
    async reverse(id, { actor, date, label } = {}) {
      const acteur = exigerHumain(actor, 'Contre-passer une écriture');
      const ecriture = await ecrire(async (tx) => {
        const originale = await tx.getEntry(id);
        if (!originale) throw new LedgerError('ENTRY_NOT_FOUND', `Écriture introuvable : ${id}.`);
        if (originale.status !== 'posted') throw new LedgerError('ENTRY_NOT_POSTED', 'Un brouillon se modifie ou se supprime, il ne se contre-passe pas.');
        if (originale.reverses) throw new LedgerError('ALREADY_REVERSED', 'On ne contre-passe pas une contre-passation : repasse l\'écriture correcte.');
        if ((await tx.listEntries({ reverses: id })).length) throw new LedgerError('ALREADY_REVERSED', `L'écriture ${originale.number} est déjà contre-passée.`);
        if (originale.meta && (originale.meta.kind === 'closing' || originale.meta.kind === 'opening')) {
          throw new LedgerError('RESERVED_JOURNAL', 'Les écritures de clôture et d\'à-nouveaux ne se contre-passent pas.');
        }
        for (const ligne of originale.lines) {
          if ((await tx.listMatchings({ lineId: ligne.id })).length) {
            throw new LedgerError('LINE_MATCHED', `La ligne ${ligne.id} est lettrée : délettre-la avant de contre-passer.`);
          }
        }
        const pointees = new Set((await tx.listStatementLines({})).flatMap((l) => l.matchedLineIds));
        const pointee = originale.lines.find((l) => pointees.has(l.id));
        if (pointee) throw new LedgerError('LINE_MATCHED', `La ligne ${pointee.id} est pointée sur un relevé : dépointe-la avant de contre-passer.`);
        const sequence = await tx.getSequence(originale.journal, originale.fiscalYear);
        const dateParDefaut = sequence && sequence.lastDate > originale.date ? sequence.lastDate : originale.date;
        const lignes = originale.lines.map(({ id: _id, carriedFrom: _report, ...ligne }) => ({
          ...ligne,
          debit: ligne.credit,
          credit: ligne.debit,
          amountCurrency: -ligne.amountCurrency
        }));
        return inscrireSysteme(tx, {
          journal: originale.journal,
          date: date || dateParDefaut,
          label: label || `Contre-passation de ${originale.number}`,
          lines: lignes,
          reverses: id,
          meta: { kind: 'reversal' }
        }, acteur);
      });
      if (hooks.afterValidate) await hooks.afterValidate(ecriture, acteur);
      return ecriture;
    },

    async getEntry(id) {
      return lire((tx) => tx.getEntry(id));
    },

    async listEntries(filtre = {}) {
      return lire((tx) => tx.listEntries(filtre));
    },

    // ——— Lettrage ———

    /**
     * Lettre des lignes d'un même compte lettrable (et d'un même tiers) :
     * facture et règlement(s). Somme nulle → lettrage total ; sinon partiel.
     * En devise, si la somme est nulle en devise mais pas en devise de tenue,
     * l'écart de change est passé (776 gain / 676 perte) et le lettrage est
     * total : il faut alors un humain.
     */
    async reconcile(idsLignes, { actor, date, journal: journalChange = 'OD' } = {}) {
      const acteur = verifierActeur(actor);
      if (!Array.isArray(idsLignes) || idsLignes.length < 2) throw new LedgerError('INVALID_MATCHING', 'Au moins deux lignes à lettrer.');
      return ecrire(async (tx) => {
        let lignes = await lignesParId(tx, [...new Set(idsLignes)]);
        const reportees = await lignesReportees(tx);
        const reportee = lignes.find((l) => reportees.has(l.id));
        if (reportee) throw new LedgerError('LINE_CARRIED_FORWARD', `La ligne ${reportee.id} a été reportée en à-nouveaux : lettre la ligne reportée.`);
        const codeCompte = lignes[0].account;
        const c = await compte(tx, codeCompte);
        if (!c.reconcile) throw new LedgerError('ACCOUNT_NOT_RECONCILABLE', `Le compte ${codeCompte} n'est pas lettrable.`);
        if (lignes.some((l) => l.account !== codeCompte)) throw new LedgerError('INVALID_MATCHING', 'Toutes les lignes doivent être sur le même compte.');
        const tiers = lignes[0].partner || null;
        if (lignes.some((l) => (l.partner || null) !== tiers)) throw new LedgerError('INVALID_MATCHING', 'Toutes les lignes doivent concerner le même tiers.');

        // Une ligne déjà dans un lettrage partiel le rejoint ; un lettrage total est figé.
        const absorbes = [];
        for (const ligne of lignes) {
          const [existant] = await tx.listMatchings({ lineId: ligne.id });
          if (!existant) continue;
          if (existant.status === 'full') throw new LedgerError('ALREADY_MATCHED', `La ligne ${ligne.id} est déjà lettrée (${existant.letters}).`);
          if (!absorbes.some((m) => m.code === existant.code)) absorbes.push(existant);
        }
        const supplementaires = absorbes.flatMap((m) => m.lineIds).filter((idL) => !lignes.some((l) => l.id === idL));
        if (supplementaires.length) lignes = [...lignes, ...(await lignesParId(tx, supplementaires))];
        for (const m of absorbes) await tx.deleteMatching(m.code);

        let solde = somme(lignes.map((l) => l.debit - l.credit));
        const monnaies = [...new Set(lignes.map((l) => l.currency))];
        let ecartChange = null;
        if (solde !== 0 && monnaies.length === 1 && monnaies[0] !== devise && somme(lignes.map((l) => l.amountCurrency)) === 0) {
          exigerHumain(acteur, "Passer l'écart de change du lettrage");
          const gain = solde < 0;
          const compteChange = gain ? profil.exchangeGain : profil.exchangeLoss;
          await compte(tx, compteChange);
          const dateEcart = date || lignes.map((l) => l.date).sort().pop();
          ecartChange = await inscrireSysteme(tx, {
            journal: journalChange,
            date: dateEcart,
            label: `Écart de change ${codeCompte}${tiers ? ` ${tiers}` : ''}`,
            lines: [
              {
                account: codeCompte,
                ...(tiers ? { partner: tiers } : {}),
                label: 'Écart de change sur lettrage',
                debit: solde < 0 ? -solde : 0,
                credit: solde > 0 ? solde : 0,
                currency: monnaies[0],
                amountCurrency: 0
              },
              {
                account: compteChange,
                label: gain ? 'Gain de change' : 'Perte de change',
                debit: solde > 0 ? solde : 0,
                credit: solde < 0 ? -solde : 0,
                currency: devise,
                amountCurrency: solde
              }
            ],
            meta: { kind: 'exchange-difference' }
          }, acteur);
          lignes = [...lignes, { ...ecartChange.lines[0], date: ecartChange.date, entryId: ecartChange.id }];
          solde = 0;
        }

        const lettresCode = absorbes.length ? absorbes[0].letters : await prochainesLettres(tx, codeCompte);
        const lettrage = {
          code: `${codeCompte}:${lettresCode}`,
          letters: lettresCode,
          account: codeCompte,
          partner: tiers,
          lineIds: lignes.map((l) => l.id),
          status: solde === 0 ? 'full' : 'partial',
          residual: solde,
          createdAt: horodatage(),
          createdBy: acteur,
          ...(ecartChange ? { exchangeEntryId: ecartChange.id } : {})
        };
        await tx.insertMatching(lettrage);
        return lettrage;
      });
    },

    /** Délettre. L'éventuelle écriture d'écart de change reste : contre-passe-la si besoin. */
    async unreconcile(code, { actor } = {}) {
      verifierActeur(actor);
      return ecrire(async (tx) => {
        if (!(await tx.deleteMatching(code))) throw new LedgerError('MATCHING_NOT_FOUND', `Lettrage introuvable : ${code}.`);
        return true;
      });
    },

    async listMatchings(filtre = {}) {
      return lire((tx) => tx.listMatchings(filtre));
    },

    /** Pièces non lettrées (ou lettrées partiellement) d'un compte, d'un tiers. */
    async openItems({ account, partner } = {}) {
      return lire(async (tx) => {
        const lettrages = await tx.listMatchings({ account });
        const lettrees = new Set(lettrages.filter((m) => m.status === 'full').flatMap((m) => m.lineIds));
        const partiels = new Map(lettrages.filter((m) => m.status === 'partial').flatMap((m) => m.lineIds.map((idL) => [idL, m.letters])));
        const reportees = await lignesReportees(tx);
        const items = [];
        for (const e of await ecrituresValidees(tx)) {
          for (const l of e.lines) {
            if (l.account !== account || lettrees.has(l.id) || reportees.has(l.id)) continue;
            if (partner !== undefined && (l.partner || null) !== partner) continue;
            items.push({
              lineId: l.id, entryId: e.id, number: e.number, date: e.date, label: l.label, partner: l.partner || null,
              debit: l.debit, credit: l.credit, currency: l.currency, amountCurrency: l.amountCurrency,
              ...(partiels.has(l.id) ? { partialMatching: partiels.get(l.id) } : {})
            });
          }
        }
        return items;
      });
    },

    // ——— Rapprochement bancaire ———

    /**
     * Importe des lignes de relevé : montant signé en plus petite unité
     * (+ entrée d'argent, − sortie). Une ligne déjà importée (même id) est
     * ignorée si identique, refusée si elle diffère.
     */
    async importStatement({ account, lines }, { actor } = {}) {
      verifierActeur(actor);
      return ecrire(async (tx) => {
        const c = await compte(tx, account);
        if (c.class !== 5) throw new LedgerError('INVALID_STATEMENT', `Le compte ${account} n'est pas un compte de trésorerie.`);
        const existantes = new Map((await tx.listStatementLines({ account })).map((l) => [l.id, l]));
        const nouvelles = [];
        let ignorees = 0;
        for (const brute of lines || []) {
          verifierDate(brute.date);
          verifierMontant(brute.amount, 'amount');
          const ligne = {
            id: brute.id || randomUUID(),
            account,
            date: brute.date,
            label: brute.label || '',
            amount: brute.amount,
            ...(brute.reference ? { reference: String(brute.reference) } : {}),
            matchedLineIds: []
          };
          const deja = existantes.get(ligne.id);
          if (deja) {
            if (deja.date !== ligne.date || deja.amount !== ligne.amount) {
              throw new LedgerError('DUPLICATE_STATEMENT_LINE', `La ligne de relevé ${ligne.id} existe avec un autre contenu.`);
            }
            ignorees += 1;
            continue;
          }
          nouvelles.push(ligne);
        }
        await tx.insertStatementLines(nouvelles);
        return { imported: nouvelles.length, skipped: ignorees, lines: nouvelles };
      });
    },

    /** Pointe des lignes de relevé avec des lignes du grand livre : sommes égales exigées. */
    async matchStatement(idsReleve, idsLignes, { actor } = {}) {
      verifierActeur(actor);
      return ecrire(async (tx) => {
        const releve = idsReleve.map((idR) => {
          if (typeof idR !== 'string') throw new LedgerError('INVALID_STATEMENT', 'Identifiant de relevé attendu.');
          return idR;
        });
        const toutes = await tx.listStatementLines({});
        const choisies = releve.map((idR) => {
          const l = toutes.find((x) => x.id === idR);
          if (!l) throw new LedgerError('STATEMENT_LINE_NOT_FOUND', `Ligne de relevé introuvable : ${idR}.`);
          if (l.matchedLineIds.length) throw new LedgerError('ALREADY_MATCHED', `La ligne de relevé ${idR} est déjà pointée.`);
          return l;
        });
        const compteBanque = choisies[0].account;
        if (choisies.some((l) => l.account !== compteBanque)) throw new LedgerError('INVALID_STATEMENT', 'Lignes de relevé de comptes différents.');
        const lignes = await lignesParId(tx, idsLignes);
        if (lignes.some((l) => l.account !== compteBanque)) throw new LedgerError('INVALID_STATEMENT', `Les lignes du grand livre doivent être sur ${compteBanque}.`);
        const dejaPointees = new Set(toutes.flatMap((l) => l.matchedLineIds));
        const conflit = lignes.find((l) => dejaPointees.has(l.id));
        if (conflit) throw new LedgerError('ALREADY_MATCHED', `La ligne ${conflit.id} est déjà pointée.`);
        const totalReleve = somme(choisies.map((l) => l.amount));
        const totalLivre = somme(lignes.map((l) => l.debit - l.credit));
        if (totalReleve !== totalLivre) {
          throw new LedgerError('STATEMENT_MISMATCH', `Relevé ${totalReleve} ≠ grand livre ${totalLivre}.`, { statement: totalReleve, book: totalLivre });
        }
        const groupe = randomUUID();
        for (const l of choisies) await tx.updateStatementLine(l.id, { matchedLineIds: lignes.map((x) => x.id), matchGroup: groupe });
        return { group: groupe, statementLineIds: releve, lineIds: lignes.map((x) => x.id), amount: totalReleve };
      });
    },

    async unmatchStatement(idReleve, { actor } = {}) {
      verifierActeur(actor);
      return ecrire(async (tx) => {
        const toutes = await tx.listStatementLines({});
        const cible = toutes.find((l) => l.id === idReleve);
        if (!cible || !cible.matchGroup) throw new LedgerError('STATEMENT_LINE_NOT_FOUND', `Aucun pointage pour ${idReleve}.`);
        for (const l of toutes.filter((x) => x.matchGroup === cible.matchGroup)) {
          await tx.updateStatementLine(l.id, { matchedLineIds: [], matchGroup: null });
        }
        return true;
      });
    },

    /**
     * Pointage automatique prudent : une ligne de relevé et une ligne du
     * livre de même montant, à `toleranceDays` jours près, et seulement quand
     * l'appariement est unique dans les deux sens.
     */
    async autoMatchStatement(account, { actor, toleranceDays = 3 } = {}) {
      verifierActeur(actor);
      const paires = await lire(async (tx) => {
        const releve = (await tx.listStatementLines({ account })).filter((l) => !l.matchedLineIds.length);
        const pointees = new Set((await tx.listStatementLines({ account })).flatMap((l) => l.matchedLineIds));
        const livre = [];
        for (const e of await ecrituresValidees(tx)) {
          for (const l of e.lines) if (l.account === account && !pointees.has(l.id)) livre.push({ ...l, date: e.date });
        }
        const jours = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
        const candidats = (r) => livre.filter((l) => l.debit - l.credit === r.amount && jours(l.date, r.date) <= toleranceDays);
        const resultat = [];
        for (const r of releve) {
          const c = candidats(r);
          if (c.length !== 1) continue;
          const inverse = releve.filter((autre) => autre.amount === r.amount && jours(c[0].date, autre.date) <= toleranceDays);
          if (inverse.length === 1) resultat.push([r.id, c[0].id]);
        }
        return resultat;
      });
      for (const [idR, idL] of paires) await ledger.matchStatement([idR], [idL], { actor });
      return { matched: paires.length };
    },

    /**
     * État de rapprochement à une date : solde comptable, solde du relevé,
     * et les écarts qui les expliquent (opérations pas encore passées en
     * banque, opérations de la banque pas encore en comptabilité).
     */
    async bankReconciliation(account, { date, statementBalance } = {}) {
      verifierDate(date);
      return lire(async (tx) => {
        await compte(tx, account);
        const releve = (await tx.listStatementLines({ account })).filter((l) => l.date <= date);
        const pointees = new Set((await tx.listStatementLines({ account })).flatMap((l) => l.matchedLineIds));
        const livre = [];
        for (const e of await ecrituresValidees(tx, { to: date })) {
          for (const l of e.lines) if (l.account === account) livre.push({ lineId: l.id, number: e.number, date: e.date, label: l.label, amount: l.debit - l.credit });
        }
        const soldeLivre = somme(livre.map((l) => l.amount));
        const soldeReleve = statementBalance === undefined ? somme(releve.map((l) => l.amount)) : verifierMontant(statementBalance, 'statementBalance');
        const nonPointeesLivre = livre.filter((l) => !pointees.has(l.lineId));
        const nonPointeesReleve = releve.filter((l) => !l.matchedLineIds.length);
        const rapproche = soldeLivre - somme(nonPointeesLivre.map((l) => l.amount)) + somme(nonPointeesReleve.map((l) => l.amount));
        return {
          account,
          date,
          bookBalance: soldeLivre,
          statementBalance: soldeReleve,
          unmatchedBook: nonPointeesLivre,
          unmatchedStatement: nonPointeesReleve,
          reconciledBalance: rapproche,
          difference: soldeReleve - rapproche,
          balanced: soldeReleve === rapproche
        };
      });
    },

    // ——— États ———

    async journalReport(code, opts = {}) {
      return lire(async (tx) => {
        await journal(tx, code);
        const { exercice, debut, fin } = await perimetre(tx, opts);
        const ecritures = (await ecrituresValidees(tx, { fiscalYear: exercice.code, journal: code, from: debut, to: fin }))
          .sort((a, b) => a.sequence - b.sequence);
        return {
          journal: code,
          fiscalYear: exercice.code,
          entries: ecritures,
          totals: {
            debit: somme(ecritures.map((e) => e.totals.debit)),
            credit: somme(ecritures.map((e) => e.totals.credit))
          }
        };
      });
    },

    /** Grand livre (général, ou auxiliaire avec byPartner). `accounts` : codes ou préfixes. */
    async generalLedger(opts = {}) {
      return lire(async (tx) => {
        const { exercice, debut, fin, ouverture, periode } = await perimetre(tx, opts);
        const prefixes = opts.accounts || null;
        const keep = (ligne) => (!prefixes || prefixes.some((p) => ligne.account.startsWith(p)))
          && (opts.partner === undefined || (ligne.partner || null) === opts.partner);
        return {
          fiscalYear: exercice.code,
          from: debut,
          to: fin,
          accounts: reports.generalLedger({ opening: ouverture, period: periode, describe: await decrireDepuis(tx), keep, byPartner: Boolean(opts.byPartner) })
        };
      });
    },

    async trialBalance(opts = {}) {
      return lire(async (tx) => {
        const { exercice, debut, fin, ouverture, periode } = await perimetre(tx, opts);
        return { fiscalYear: exercice.code, from: debut, to: fin, ...reports.trialBalance({ opening: ouverture, period: periode, describe: await decrireDepuis(tx) }) };
      });
    },

    async balanceSheet(opts = {}) {
      return lire(async (tx) => {
        const { exercice, fin, ouverture, periode } = await perimetre(tx, { ...opts, from: undefined, includeClosing: false });
        const nets = reports.soldes([...ouverture, ...periode]);
        return { fiscalYear: exercice.code, date: fin, currency: devise, ...reports.balanceSheet({ layout: presentations.balanceSheet, nets, describe: await decrireDepuis(tx) }) };
      });
    },

    async incomeStatement(opts = {}) {
      return lire(async (tx) => {
        const { exercice, debut, fin, periode } = await perimetre(tx, { ...opts, includeClosing: false });
        const nets = reports.soldes(periode);
        return { fiscalYear: exercice.code, from: debut, to: fin, currency: devise, ...reports.incomeStatement({ layout: presentations.incomeStatement, nets, describe: await decrireDepuis(tx) }) };
      });
    },

    async vatReport({ from, to, collected = profil.vatCollected, deductible = profil.vatDeductible } = {}) {
      verifierDate(from, 'from');
      verifierDate(to, 'to');
      return lire(async (tx) => {
        const ecritures = (await ecrituresValidees(tx, { from, to })).filter((e) => !(e.meta && (e.meta.kind === 'opening' || e.meta.kind === 'closing')));
        return { from, to, currency: devise, ...reports.vatReport({ entries: ecritures, collected, deductible, describe: await decrireDepuis(tx) }) };
      });
    }
  };

  /**
   * Lignes d'à-nouveaux : classes 1 à 5 seulement. Comptes lettrables :
   * une ligne par pièce ouverte (ou par lettrage partiel). Autres : un solde
   * par compte, tiers et devise.
   */
  async function lignesANouveau(tx, ecritures, code) {
    const libelle = `À-nouveau ${code}`;
    const lettrages = await tx.listMatchings({});
    const lettrees = new Set(lettrages.filter((m) => m.status === 'full').flatMap((m) => m.lineIds));
    const partielles = new Map();
    for (const m of lettrages.filter((x) => x.status === 'partial')) for (const idL of m.lineIds) partielles.set(idL, m);
    const groupes = new Map();
    const lignes = [];
    const ajouter = (cle, base, net, netDevise, origine) => {
      const g = groupes.get(cle) || { ...base, net: 0, netDevise: 0, carriedFrom: [] };
      g.net = somme([g.net, net]);
      g.netDevise = somme([g.netDevise, netDevise]);
      g.carriedFrom.push(origine);
      groupes.set(cle, g);
    };
    for (const e of ecritures) {
      for (const l of e.lines) {
        const classe = Number(l.account[0]);
        if (classe < 1 || classe > 5) continue;
        const c = await compte(tx, l.account);
        const base = { account: l.account, ...(l.partner ? { partner: l.partner } : {}), currency: l.currency };
        if (c.reconcile) {
          if (lettrees.has(l.id)) continue;
          const partiel = partielles.get(l.id);
          const cle = partiel ? `p|${partiel.code}` : `l|${l.id}`;
          ajouter(cle, { ...base, label: partiel ? `${libelle} (lettrage partiel ${partiel.letters})` : `${libelle} — ${l.label || e.label}` }, l.debit - l.credit, l.amountCurrency, l.id);
        } else {
          ajouter(`s|${l.account}|${l.partner || ''}|${l.currency}`, { ...base, label: libelle }, l.debit - l.credit, l.amountCurrency, null);
        }
      }
    }
    for (const g of groupes.values()) {
      if (g.net === 0 && g.netDevise === 0) continue;
      const origines = g.carriedFrom.filter(Boolean);
      lignes.push({
        account: g.account,
        ...(g.partner ? { partner: g.partner } : {}),
        label: g.label,
        debit: g.net > 0 ? g.net : 0,
        credit: g.net < 0 ? -g.net : 0,
        currency: g.currency,
        amountCurrency: g.netDevise,
        ...(origines.length ? { carriedFrom: origines } : {})
      });
    }
    return lignes;
  }

  return ledger;
}

module.exports = { createLedger, JOURNAL_TYPES: TYPES_JOURNAL, ACTOR_KINDS: NATURES_ACTEUR };
