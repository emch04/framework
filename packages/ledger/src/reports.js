/**
 * Calcul des états à partir d'écritures validées. Fonctions pures : elles
 * ne lisent rien, on leur passe les écritures et la description des comptes.
 * Tous les montants sont dans la devise de tenue (fonctionnelle) de l'entité.
 */
const { somme } = require('./money');
const { trouverRubrique } = require('./layouts');

function comparerCodes(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Cumuls débit / crédit par compte. */
function cumuls(ecritures, filtreLigne = () => true) {
  const parCompte = new Map();
  for (const ecriture of ecritures) {
    for (const ligne of ecriture.lines) {
      if (!filtreLigne(ligne)) continue;
      const cumul = parCompte.get(ligne.account) || { debit: 0, credit: 0 };
      cumul.debit = somme([cumul.debit, ligne.debit]);
      cumul.credit = somme([cumul.credit, ligne.credit]);
      parCompte.set(ligne.account, cumul);
    }
  }
  return parCompte;
}

function cote(net) {
  return net >= 0 ? { debit: net, credit: 0 } : { debit: 0, credit: -net };
}

/**
 * Balance générale : à-nouveaux (ouverture), mouvements de la période, solde.
 */
function trialBalance({ opening, period, describe }) {
  const ouverture = cumuls(opening);
  const mouvements = cumuls(period);
  const codes = [...new Set([...ouverture.keys(), ...mouvements.keys()])].sort(comparerCodes);
  const lignes = codes.map((code) => {
    const o = ouverture.get(code) || { debit: 0, credit: 0 };
    const m = mouvements.get(code) || { debit: 0, credit: 0 };
    const netOuverture = o.debit - o.credit;
    const netFinal = netOuverture + m.debit - m.credit;
    const compte = describe(code);
    const ouv = cote(netOuverture);
    const fin = cote(netFinal);
    return {
      account: code,
      name: compte.name,
      class: compte.class,
      openingDebit: ouv.debit,
      openingCredit: ouv.credit,
      debit: m.debit,
      credit: m.credit,
      closingDebit: fin.debit,
      closingCredit: fin.credit
    };
  });
  const totaliser = (liste) => ({
    openingDebit: somme(liste.map((l) => l.openingDebit)),
    openingCredit: somme(liste.map((l) => l.openingCredit)),
    debit: somme(liste.map((l) => l.debit)),
    credit: somme(liste.map((l) => l.credit)),
    closingDebit: somme(liste.map((l) => l.closingDebit)),
    closingCredit: somme(liste.map((l) => l.closingCredit))
  });
  const classes = [...new Set(lignes.map((l) => l.class))].sort().map((classe) => ({
    class: classe,
    ...totaliser(lignes.filter((l) => l.class === classe))
  }));
  const totaux = totaliser(lignes);
  return {
    rows: lignes,
    classes,
    totals: totaux,
    balanced: totaux.debit === totaux.credit && totaux.closingDebit === totaux.closingCredit
      && totaux.openingDebit === totaux.openingCredit
  };
}

/** Soldes nets (débit − crédit) par compte, toutes écritures confondues. */
function soldes(ecritures) {
  const nets = new Map();
  for (const [code, c] of cumuls(ecritures)) nets.set(code, c.debit - c.credit);
  return nets;
}

/**
 * Bilan : comptes des classes 1 à 5 répartis dans les rubriques ; le
 * résultat des classes 6 à 8 non encore soldé (exercice non clôturé) est
 * ajouté à la rubrique résultat pour que l'actif égale le passif.
 */
function balanceSheet({ layout, nets, describe }) {
  const tous = [...layout.assets, ...layout.liabilities].filter((r) => r.type === 'rubric');
  const valeurs = new Map(tous.map((r) => [r.code, { gross: 0, depreciation: 0, amount: 0, accounts: [] }]));
  const nonClasses = { assets: [], liabilities: [] };
  const cotePassif = new Set(layout.liabilities.filter((r) => r.type === 'rubric').map((r) => r.code));
  let resultatEnCours = 0;

  for (const [code, net] of [...nets.entries()].sort((a, b) => comparerCodes(a[0], b[0]))) {
    if (net === 0) continue;
    const classe = Number(code[0]);
    if (classe >= 6 && classe <= 8) { resultatEnCours -= net; continue; }
    if (classe === 9) continue;
    const trouve = trouverRubrique(tous, code, net > 0 ? 'debit' : 'credit');
    const compte = { account: code, name: describe(code).name };
    if (!trouve) {
      if (net > 0) nonClasses.assets.push({ ...compte, amount: net });
      else nonClasses.liabilities.push({ ...compte, amount: -net });
      continue;
    }
    const v = valeurs.get(trouve.rubrique.code);
    const passif = cotePassif.has(trouve.rubrique.code);
    const montant = passif ? -net : net;
    v.accounts.push({ ...compte, amount: montant, ...(trouve.contra ? { contra: true } : {}) });
    v.amount = somme([v.amount, montant]);
    if (trouve.contra) v.depreciation = somme([v.depreciation, -montant]);
    else v.gross = somme([v.gross, montant]);
  }

  const resultat = valeurs.get(layout.resultRubric);
  if (resultatEnCours !== 0) {
    resultat.accounts.push({ account: null, name: "Résultat de l'exercice non encore affecté (classes 6 à 8)", amount: resultatEnCours });
    resultat.amount = somme([resultat.amount, resultatEnCours]);
    resultat.gross = somme([resultat.gross, resultatEnCours]);
  }

  function section(elements, actif) {
    const montants = new Map();
    const lignes = elements.map((element) => {
      if (element.type === 'rubric') {
        const v = valeurs.get(element.code);
        montants.set(element.code, v.amount);
        return actif
          ? { code: element.code, label: element.label, gross: v.gross, depreciation: v.depreciation, net: v.amount, accounts: v.accounts }
          : { code: element.code, label: element.label, amount: v.amount, accounts: v.accounts };
      }
      const valeur = somme(element.of.map((c) => montants.get(c)));
      montants.set(element.code, valeur);
      return actif ? { code: element.code, label: element.label, total: true, net: valeur } : { code: element.code, label: element.label, total: true, amount: valeur };
    });
    return lignes;
  }

  const actif = section(layout.assets, true);
  const passif = section(layout.liabilities, false);
  const totalActif = somme([
    ...layout.assets.filter((r) => r.type === 'rubric').map((r) => valeurs.get(r.code).amount),
    ...nonClasses.assets.map((c) => c.amount)
  ]);
  const totalPassif = somme([
    ...layout.liabilities.filter((r) => r.type === 'rubric').map((r) => valeurs.get(r.code).amount),
    ...nonClasses.liabilities.map((c) => c.amount)
  ]);
  return {
    layout: layout.id,
    assets: actif,
    liabilities: passif,
    unclassified: nonClasses,
    totals: { assets: totalActif, liabilities: totalPassif },
    totalCodes: layout.totals,
    result: resultat.amount,
    balanced: totalActif === totalPassif
  };
}

/** Compte de résultat : rubriques, soldes intermédiaires et résultat net. */
function incomeStatement({ layout, nets, describe }) {
  const rubriques = layout.items.filter((i) => i.type === 'rubric');
  const valeurs = new Map(rubriques.map((r) => [r.code, { amount: 0, accounts: [] }]));
  const nonClasses = [];
  let produits = 0;
  let charges = 0;

  for (const [code, net] of [...nets.entries()].sort((a, b) => comparerCodes(a[0], b[0]))) {
    const classe = Number(code[0]);
    if (net === 0 || classe < 6 || classe > 8) continue;
    let meilleure = null;
    for (const r of rubriques) {
      for (const prefixe of r.prefixes) {
        if (code.startsWith(prefixe) && (!meilleure || prefixe.length > meilleure.longueur)) meilleure = { r, longueur: prefixe.length };
      }
    }
    const compte = { account: code, name: describe(code).name };
    if (!meilleure) {
      nonClasses.push({ ...compte, amount: -net });
      produits = somme([produits, Math.max(-net, 0)]);
      charges = somme([charges, Math.max(net, 0)]);
      continue;
    }
    const montant = meilleure.r.nature === 'income' ? -net : net;
    if (meilleure.r.nature === 'income') produits = somme([produits, montant]);
    else charges = somme([charges, montant]);
    const v = valeurs.get(meilleure.r.code);
    v.amount = somme([v.amount, montant]);
    v.accounts.push({ ...compte, amount: montant });
  }

  const montants = new Map();
  const lignes = layout.items.map((item) => {
    if (item.type === 'rubric') {
      const v = valeurs.get(item.code);
      montants.set(item.code, v.amount);
      return { code: item.code, label: item.label, nature: item.nature, amount: v.amount, accounts: v.accounts };
    }
    const valeur = somme(item.plus.map((c) => montants.get(c))) - somme(item.minus.map((c) => montants.get(c)));
    montants.set(item.code, valeur);
    return { code: item.code, label: item.label, aggregate: true, amount: valeur };
  });
  const horsRubriques = somme(nonClasses.map((c) => c.amount));
  const resultat = somme([montants.get(layout.result), horsRubriques]);
  return {
    layout: layout.id,
    lines: lignes,
    unclassified: nonClasses,
    totals: { income: produits, expenses: charges },
    result: resultat,
    resultCode: layout.result
  };
}

/** Grand livre : lignes par compte avec solde progressif. */
function generalLedger({ opening, period, describe, keep = () => true, byPartner = false }) {
  const cle = (ligne) => (byPartner ? `${ligne.account}|${ligne.partner || ''}` : ligne.account);
  const groupes = new Map();
  const groupe = (ligne) => {
    const k = cle(ligne);
    if (!groupes.has(k)) {
      groupes.set(k, {
        account: ligne.account,
        name: describe(ligne.account).name,
        ...(byPartner ? { partner: ligne.partner || null } : {}),
        opening: 0,
        lines: [],
        totalDebit: 0,
        totalCredit: 0
      });
    }
    return groupes.get(k);
  };
  for (const ecriture of opening) {
    for (const ligne of ecriture.lines) {
      if (!keep(ligne)) continue;
      const g = groupe(ligne);
      g.opening = somme([g.opening, ligne.debit - ligne.credit]);
    }
  }
  const ordonnees = [...period].sort((a, b) => (a.date !== b.date ? comparerCodes(a.date, b.date) : comparerCodes(a.number, b.number)));
  for (const ecriture of ordonnees) {
    for (const ligne of ecriture.lines) {
      if (!keep(ligne)) continue;
      const g = groupe(ligne);
      g.lines.push({
        lineId: ligne.id,
        entryId: ecriture.id,
        number: ecriture.number,
        journal: ecriture.journal,
        date: ecriture.date,
        label: ligne.label || ecriture.label,
        partner: ligne.partner || null,
        currency: ligne.currency,
        amountCurrency: ligne.amountCurrency,
        debit: ligne.debit,
        credit: ligne.credit
      });
      g.totalDebit = somme([g.totalDebit, ligne.debit]);
      g.totalCredit = somme([g.totalCredit, ligne.credit]);
    }
  }
  const resultat = [...groupes.values()].sort((a, b) => comparerCodes(a.account, b.account)
    || comparerCodes(a.partner || '', b.partner || ''));
  for (const g of resultat) {
    let courant = g.opening;
    for (const ligne of g.lines) {
      courant = somme([courant, ligne.debit - ligne.credit]);
      ligne.balance = courant;
    }
    g.closing = courant;
  }
  return resultat;
}

/**
 * TVA d'une période : collectée (crédit des comptes de TVA facturée),
 * déductible (débit des comptes de TVA récupérable), et détail par taxe
 * quand les lignes portent leur code de taxe.
 */
function vatReport({ entries, collected, deductible, describe }) {
  const commence = (code, prefixes) => prefixes.some((p) => code.startsWith(p));
  const parCompte = new Map();
  const parTaxe = new Map();
  let collectee = 0;
  let deductibleTotal = 0;
  for (const ecriture of entries) {
    for (const ligne of ecriture.lines) {
      const estCollectee = commence(ligne.account, collected);
      const estDeductible = commence(ligne.account, deductible);
      if (!estCollectee && !estDeductible) continue;
      const montant = estCollectee ? ligne.credit - ligne.debit : ligne.debit - ligne.credit;
      if (estCollectee) collectee = somme([collectee, montant]);
      else deductibleTotal = somme([deductibleTotal, montant]);
      const compte = parCompte.get(ligne.account) || { account: ligne.account, name: describe(ligne.account).name, kind: estCollectee ? 'collected' : 'deductible', amount: 0 };
      compte.amount = somme([compte.amount, montant]);
      parCompte.set(ligne.account, compte);
      if (ligne.tax && ligne.tax.code) {
        const taxe = parTaxe.get(ligne.tax.code) || { code: ligne.tax.code, base: 0, amount: 0 };
        const signe = Math.sign(montant) || 1;
        taxe.base = somme([taxe.base, signe * Math.abs(ligne.tax.base || 0)]);
        taxe.amount = somme([taxe.amount, montant]);
        parTaxe.set(ligne.tax.code, taxe);
      }
    }
  }
  return {
    collected: collectee,
    deductible: deductibleTotal,
    /** Positif : TVA à reverser. Négatif : crédit de TVA. */
    due: collectee - deductibleTotal,
    accounts: [...parCompte.values()].sort((a, b) => comparerCodes(a.account, b.account)),
    taxes: [...parTaxe.values()].sort((a, b) => comparerCodes(a.code, b.code))
  };
}

module.exports = { trialBalance, balanceSheet, incomeStatement, generalLedger, vatReport, soldes };
