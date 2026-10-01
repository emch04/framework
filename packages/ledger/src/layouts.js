/**
 * Présentation des états financiers : bilan et compte de résultat.
 *
 * Le SYSCOHADA révisé (Acte uniforme de 2017) fixe des rubriques repérées par
 * des codes de deux lettres (AD, AI… pour l'actif, CA, CB… pour le passif,
 * TA, RA, XA… pour le compte de résultat). Chaque rubrique regroupe des
 * comptes par préfixe ; le préfixe le plus long l'emporte, et pour les
 * comptes de tiers et de trésorerie (classes 4 et 5) c'est le SENS du solde
 * qui décide de l'actif ou du passif : un fournisseur débiteur est une
 * créance, une banque créditrice est un concours bancaire.
 *
 * Les comptes d'amortissement et de dépréciation (28, 29, 39, 49, 59) sont
 * des « contre-comptes » : ils viennent en déduction de la rubrique d'actif
 * qu'ils corrigent, d'où les colonnes Brut / Amortissements / Net.
 *
 * Un compte qu'aucune rubrique ne reconnaît n'est jamais perdu : il va dans
 * une ligne « non classé » qui compte dans les totaux, pour que le bilan
 * reste équilibré et que l'anomalie se voie.
 */

function rubrique(code, label, prefixes, options = {}) {
  return { type: 'rubric', code, label, prefixes, contra: options.contra || [], sign: options.sign || 'any' };
}

function total(code, label, of) {
  return { type: 'total', code, label, of };
}

const ACTIF_CIRCULANT_ET_TRESORERIE = [
  rubrique('BA', 'Actif circulant H.A.O.', ['485', '488'], { contra: ['498'], sign: 'debit' }),
  rubrique('BB', 'Stocks et encours', ['31', '32', '33', '34', '35', '36', '37', '38'], { contra: ['39'] }),
  rubrique('BH', 'Fournisseurs, avances versées', ['409'], { contra: ['490'], sign: 'debit' }),
  rubrique('BI', 'Clients', ['41'], { contra: ['491'], sign: 'debit' }),
  rubrique('BJ', 'Autres créances', ['40', '42', '43', '44', '45', '46', '47', '48'], {
    contra: ['492', '493', '494', '495', '496', '497'], sign: 'debit'
  }),
  total('BG', 'Créances et emplois assimilés', ['BH', 'BI', 'BJ']),
  total('BK', 'TOTAL ACTIF CIRCULANT', ['BA', 'BB', 'BG']),
  rubrique('BQ', 'Titres de placement', ['50'], { contra: ['590'], sign: 'debit' }),
  rubrique('BR', 'Valeurs à encaisser', ['51'], { contra: ['591'], sign: 'debit' }),
  rubrique('BS', 'Banques, chèques postaux, caisse et assimilés', ['52', '53', '54', '55', '56', '57', '58'], {
    contra: ['59'], sign: 'debit'
  }),
  total('BT', 'TOTAL TRÉSORERIE-ACTIF', ['BQ', 'BR', 'BS']),
  rubrique('BU', 'Écart de conversion-Actif', ['478'], { sign: 'debit' })
];

const PASSIF_CIRCULANT_ET_TRESORERIE = [
  rubrique('DH', 'Dettes circulantes H.A.O.', ['481', '482', '483', '484', '486', '488'], { sign: 'credit' }),
  rubrique('DI', 'Clients, avances reçues', ['419'], { sign: 'credit' }),
  rubrique('DJ', "Fournisseurs d'exploitation", ['40'], { sign: 'credit' }),
  rubrique('DK', 'Dettes fiscales et sociales', ['42', '43', '44'], { sign: 'credit' }),
  rubrique('DM', 'Autres dettes', ['41', '45', '46', '47'], { sign: 'credit' }),
  rubrique('DN', 'Provisions pour risques à court terme', ['499']),
  total('DP', 'TOTAL PASSIF CIRCULANT', ['DH', 'DI', 'DJ', 'DK', 'DM', 'DN']),
  rubrique('DQ', "Banques, crédits d'escompte", ['564', '565'], { sign: 'credit' }),
  rubrique('DR', 'Banques, établissements financiers et crédits de trésorerie', ['52', '53', '54', '55', '56', '57', '58', '599'], { sign: 'credit' }),
  total('DT', 'TOTAL TRÉSORERIE-PASSIF', ['DQ', 'DR']),
  rubrique('DV', 'Écart de conversion-Passif', ['479'], { sign: 'credit' })
];

const BILAN_SYSCOHADA = Object.freeze({
  id: 'syscohada',
  assets: [
    rubrique('AD', 'Immobilisations incorporelles', ['21'], { contra: ['281', '291'] }),
    rubrique('AI', 'Immobilisations corporelles', ['22', '23', '24'], { contra: ['282', '283', '284', '292', '293', '294'] }),
    rubrique('AP', 'Avances et acomptes versés sur immobilisations', ['25'], { contra: ['295'] }),
    rubrique('AQ', 'Immobilisations financières', ['26', '27'], { contra: ['296', '297'] }),
    total('AZ', 'TOTAL ACTIF IMMOBILISÉ', ['AD', 'AI', 'AP', 'AQ']),
    ...ACTIF_CIRCULANT_ET_TRESORERIE
  ],
  liabilities: [
    rubrique('CA', 'Capital', ['101', '102', '103', '104']),
    rubrique('CB', 'Apporteurs capital non appelé (-)', ['109']),
    rubrique('CD', 'Primes liées au capital social', ['105']),
    rubrique('CE', 'Écarts de réévaluation', ['106']),
    rubrique('CF', 'Réserves indisponibles', ['111', '112', '113']),
    rubrique('CG', 'Réserves libres', ['11']),
    rubrique('CH', 'Report à nouveau (+ ou -)', ['12']),
    rubrique('CJ', "Résultat net de l'exercice (bénéfice + ou perte -)", ['13']),
    rubrique('CL', "Subventions d'investissement", ['14']),
    rubrique('CM', 'Provisions réglementées', ['15']),
    total('CP', 'TOTAL CAPITAUX PROPRES ET RESSOURCES ASSIMILÉES', ['CA', 'CB', 'CD', 'CE', 'CF', 'CG', 'CH', 'CJ', 'CL', 'CM']),
    rubrique('DA', 'Emprunts et dettes financières diverses', ['16', '18']),
    rubrique('DB', 'Dettes de location-acquisition', ['17']),
    rubrique('DC', 'Provisions pour risques et charges', ['19']),
    total('DD', 'TOTAL DETTES FINANCIÈRES ET RESSOURCES ASSIMILÉES', ['DA', 'DB', 'DC']),
    total('DF', 'TOTAL RESSOURCES STABLES', ['CP', 'DD']),
    ...PASSIF_CIRCULANT_ET_TRESORERIE
  ],
  resultRubric: 'CJ',
  totals: { assets: 'BZ', liabilities: 'DZ' }
});

/**
 * Bilan SYSCEBNL : même charpente que le SYSCOHADA (tiers, trésorerie,
 * écarts de conversion), mais les ressources durables et l'actif immobilisé
 * suivent les groupes du plan associatif (dotations, fonds affectés, fonds
 * reportés, immobilisations reçues en dons…), libellés repris des données.
 */
function bilanSyscebnl(groupes) {
  const libelle = (prefixe) => {
    const groupe = groupes.find((g) => g.prefix === prefixe);
    return groupe ? (groupe.labels.fr || groupe.labels.en) : prefixe;
  };
  const immobilise = ['20', '21', '22', '23', '24', '25', '26', '27'].map((p) => rubrique(`A${p}`, libelle(p), [p], {
    contra: [`28${p[1]}`, `29${p[1]}`]
  }));
  const ressource = (p) => rubrique(`C${p}`, libelle(p), [p]);
  return Object.freeze({
    id: 'syscebnl',
    assets: [...immobilise, total('AZ', 'TOTAL ACTIF IMMOBILISÉ', immobilise.map((r) => r.code)), ...ACTIF_CIRCULANT_ET_TRESORERIE],
    liabilities: [
      ...['10', '11', '12', '13', '14', '15'].map(ressource),
      total('CP', 'TOTAL FONDS PROPRES ET RESSOURCES ASSIMILÉES', ['C10', 'C11', 'C12', 'C13', 'C14', 'C15']),
      ...['16', '17'].map(ressource),
      total('CQ', 'TOTAL FONDS AFFECTÉS ET REPORTÉS', ['C16', 'C17']),
      ...['18', '19'].map(ressource),
      total('DD', 'TOTAL DETTES FINANCIÈRES ET RESSOURCES ASSIMILÉES', ['C18', 'C19']),
      total('DF', 'TOTAL RESSOURCES STABLES', ['CP', 'CQ', 'DD']),
      ...PASSIF_CIRCULANT_ET_TRESORERIE
    ],
    resultRubric: 'C13',
    totals: { assets: 'BZ', liabilities: 'DZ' }
  });
}

function produit(code, label, prefixes) {
  return { type: 'rubric', code, label, prefixes, nature: 'income' };
}
function charge(code, label, prefixes) {
  return { type: 'rubric', code, label, prefixes, nature: 'expense' };
}
/** Solde intermédiaire : somme signée de lignes déjà calculées. */
function solde(code, label, plus, moins = []) {
  return { type: 'aggregate', code, label, plus, minus: moins };
}

const RESULTAT_SYSCOHADA = Object.freeze({
  id: 'syscohada',
  items: [
    produit('TA', 'Ventes de marchandises', ['701']),
    charge('RA', 'Achats de marchandises', ['601']),
    charge('RB', 'Variation de stocks de marchandises', ['6031']),
    solde('XA', 'MARGE COMMERCIALE', ['TA'], ['RA', 'RB']),
    produit('TB', 'Ventes de produits fabriqués', ['702', '703', '704']),
    produit('TC', 'Travaux, services vendus', ['705', '706']),
    produit('TD', 'Produits accessoires', ['707', '70']),
    solde('XB', "CHIFFRE D'AFFAIRES", ['TA', 'TB', 'TC', 'TD']),
    produit('TE', 'Production stockée (ou déstockage)', ['73']),
    produit('TF', 'Production immobilisée', ['72']),
    produit('TG', "Subventions d'exploitation", ['71']),
    produit('TH', 'Autres produits', ['75', '76', '74']),
    produit('TI', "Transferts de charges d'exploitation", ['781', '78']),
    charge('RC', 'Achats de matières premières et fournitures liées', ['602']),
    charge('RD', 'Variation de stocks de matières premières et fournitures liées', ['6032']),
    charge('RE', 'Autres achats', ['604', '605', '608', '60']),
    charge('RF', "Variation de stocks d'autres approvisionnements", ['6033', '603']),
    charge('RG', 'Transports', ['61']),
    charge('RH', 'Services extérieurs', ['62', '63']),
    charge('RI', 'Impôts et taxes', ['64']),
    charge('RJ', 'Autres charges', ['65']),
    solde('XC', 'VALEUR AJOUTÉE', ['XA', 'TB', 'TC', 'TD', 'TE', 'TF', 'TG', 'TH', 'TI'], ['RC', 'RD', 'RE', 'RF', 'RG', 'RH', 'RI', 'RJ']),
    charge('RK', 'Charges de personnel', ['66']),
    solde('XD', "EXCÉDENT BRUT D'EXPLOITATION", ['XC'], ['RK']),
    produit('TJ', "Reprises d'amortissements, provisions et dépréciations", ['791', '798', '799', '79']),
    charge('RL', 'Dotations aux amortissements, aux provisions et dépréciations', ['681', '691', '68', '69']),
    solde('XE', "RÉSULTAT D'EXPLOITATION", ['XD', 'TJ'], ['RL']),
    produit('TK', 'Revenus financiers et assimilés', ['77']),
    produit('TL', 'Reprises de provisions et dépréciations financières', ['797']),
    produit('TM', 'Transferts de charges financières', ['787']),
    charge('RM', 'Frais financiers et charges assimilées', ['67']),
    charge('RN', 'Dotations aux provisions et aux dépréciations financières', ['697']),
    solde('XF', 'RÉSULTAT FINANCIER', ['TK', 'TL', 'TM'], ['RM', 'RN']),
    solde('XG', 'RÉSULTAT DES ACTIVITÉS ORDINAIRES', ['XE', 'XF']),
    produit('TN', "Produits des cessions d'immobilisations", ['82']),
    produit('TO', 'Autres produits H.A.O.', ['84', '86', '88']),
    charge('RO', "Valeurs comptables des cessions d'immobilisations", ['81']),
    charge('RP', 'Autres charges H.A.O.', ['83', '85']),
    solde('XH', 'RÉSULTAT HORS ACTIVITÉS ORDINAIRES', ['TN', 'TO'], ['RO', 'RP']),
    charge('RQ', 'Participation des travailleurs', ['87']),
    charge('RS', 'Impôts sur le résultat', ['89']),
    solde('XI', 'RÉSULTAT NET', ['XG', 'XH'], ['RQ', 'RS'])
  ],
  result: 'XI'
});

/**
 * Compte de résultat SYSCEBNL : une ligne par groupe du plan (60, 61…, 70,
 * 71…, 81…), sous-totaux activités ordinaires et H.A.O., puis l'excédent ou
 * le déficit. Le sens (charge ou produit) se lit sur la classe et, en classe
 * 8, sur la parité du groupe (81, 83, 85, 87 charges ; 82, 84, 86, 88 produits).
 */
function resultatSyscebnl(groupes) {
  const deux = groupes.filter((g) => /^[678]\d$/.test(g.prefix));
  const estCharge = (p) => p[0] === '6' || (p[0] === '8' && Number(p[1]) % 2 === 1);
  const ligne = (g) => (estCharge(g.prefix) ? charge : produit)(`G${g.prefix}`, g.labels.fr || g.labels.en, [g.prefix]);
  const ordinaires = deux.filter((g) => g.prefix[0] !== '8');
  const hao = deux.filter((g) => g.prefix[0] === '8');
  const codes = (liste, predicat) => liste.filter((g) => predicat(g.prefix)).map((g) => `G${g.prefix}`);
  return Object.freeze({
    id: 'syscebnl',
    items: [
      ...ordinaires.map(ligne),
      solde('XG', 'RÉSULTAT DES ACTIVITÉS ORDINAIRES', codes(ordinaires, (p) => !estCharge(p)), codes(ordinaires, estCharge)),
      ...hao.map(ligne),
      solde('XH', 'RÉSULTAT HORS ACTIVITÉS ORDINAIRES', codes(hao, (p) => !estCharge(p)), codes(hao, estCharge)),
      solde('XI', "RÉSULTAT NET (EXCÉDENT + OU DÉFICIT -)", ['XG', 'XH'])
    ],
    result: 'XI'
  });
}

function layoutsFor(chart) {
  if (chart.profile.layout === 'syscebnl') {
    return { balanceSheet: bilanSyscebnl(chart.groups), incomeStatement: resultatSyscebnl(chart.groups) };
  }
  return { balanceSheet: BILAN_SYSCOHADA, incomeStatement: RESULTAT_SYSCOHADA };
}

/** Rubrique gagnante pour un compte : préfixe le plus long compatible avec le sens du solde. */
function trouverRubrique(rubriques, code, sens) {
  let meilleure = null;
  let longueur = -1;
  for (const r of rubriques) {
    for (const prefixe of r.contra || []) {
      if (code.startsWith(prefixe) && prefixe.length > longueur) { meilleure = { rubrique: r, contra: true }; longueur = prefixe.length; }
    }
    if (r.sign !== 'any' && r.sign !== sens) continue;
    for (const prefixe of r.prefixes) {
      if (code.startsWith(prefixe) && prefixe.length > longueur) { meilleure = { rubrique: r, contra: false }; longueur = prefixe.length; }
    }
  }
  return meilleure;
}

module.exports = { layoutsFor, trouverRubrique };
