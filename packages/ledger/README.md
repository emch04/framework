# @astratra/ledger

Un moteur de comptabilité en partie double, avec les plans comptables OHADA
(SYSCOHADA révisé pour les entreprises, SYSCEBNL pour les associations et ONG)
et la TVA de la RDC.

Le moteur ne dépend de rien. Il ne connaît ni ta base, ni ton interface. Tu
lui confies des écritures, il garantit les règles comptables et produit les
états : journal, grand livre, balance, bilan, compte de résultat, TVA.

## Ce que le moteur garantit

| Règle | Comportement |
| --- | --- |
| Partie double | Au moins deux lignes ; total débit = total crédit, sinon `UNBALANCED_ENTRY`. |
| Montants exacts | Entiers en plus petite unité (centimes ; unité pour XAF/XOF). Les taux de change sont des fractions exactes (BigInt). Aucun nombre à virgule. |
| Multi-devises | CDF, USD, EUR, XAF, XOF (et toute devise ajoutée). Taux à la date de l'écriture, montant d'origine conservé ligne par ligne. |
| L'IA propose, un humain valide | `propose()` crée un brouillon (humain, IA ou système). Seul un acteur `kind: 'human'` peut le valider (`HUMAN_VALIDATION_REQUIRED`). |
| Immuabilité | Une écriture validée ne se modifie ni ne se supprime : on la corrige par `reverse()` (contre-passation). |
| Numérotation | Donnée à la validation, par journal et par exercice (`VT-2026-000001`), sans trou, dans l'ordre des dates (`CHRONOLOGY`). |
| Exercices | Clôture : les classes 6 à 8 sont soldées dans le résultat, puis l'exercice est verrouillé (`FISCAL_YEAR_CLOSED`) et les classes 1 à 5 sont reportées à nouveau. |
| Transactions | Chaque opération est tout ou rien et les opérations d'une même entité passent l'une après l'autre. |

## Utilisation

```js
const { createLedger, createRateTable, loadTaxes, computeTax } = require('@astratra/ledger');

const compta = createLedger({
  entity: { id: 'ecole-lumiere', chart: 'syscohada', currency: 'CDF' },
  rates: createRateTable({ rates: [{ from: 'USD', to: 'CDF', date: '2026-01-01', rate: '2850.50' }] })
});

const comptable = { id: 'u-42', kind: 'human', name: 'Mme Mbuyi' };

await compta.openFiscalYear({ code: '2026', start: '2026-01-01', end: '2026-12-31' });
await compta.addAccount({ code: '5211', name: 'Banque Equity BCDC', type: 'asset_cash' });
await compta.addJournal({ code: 'BQ', type: 'bank', name: 'Banque', account: '5211' });
await compta.addPartner({ id: 'famille-kabila', name: 'Famille Kabila', kind: 'customer' }); // collectif 4111

// Facture de 1 000 000 CDF HT + TVA 16 %
const tva = loadTaxes('cd', 'syscohada').taxes.find((t) => t.id === 'tva_sale_16');
const { lines: lignesTva, amount } = computeTax(100000000, tva);
const facture = await compta.post({
  journal: 'VT',
  date: '2026-09-05',
  label: 'Frais de scolarité septembre',
  lines: [
    { account: '4111', partner: 'famille-kabila', debit: 100000000 + amount },
    { account: '7011', credit: 100000000 },
    ...lignesTva
  ]
}, { actor: comptable });
facture.number; // 'VT-2026-000001'

// Règlement : lettré avec la facture (somme nulle → lettrage total « A »)
const paiement = await compta.post({
  journal: 'BQ', date: '2026-09-20',
  lines: [{ account: '5211', debit: 116000000 }, { account: '4111', partner: 'famille-kabila', credit: 116000000 }]
}, { actor: comptable });
await compta.reconcile([facture.lines[0].id, paiement.lines[1].id], { actor: comptable });

// Saisie en dollars : convertie en CDF au taux en vigueur à la date,
// le montant en USD reste sur chaque ligne (currency, amountCurrency)
await compta.post({
  journal: 'BQ', date: '2026-09-25', currency: 'USD', label: 'Don en dollars',
  lines: [{ account: '5211', debit: 50000 }, { account: '7588', credit: 50000 }]
}, { actor: comptable });
```

### Proposition par l'IA ou un module

```js
const brouillon = await compta.propose({
  journal: 'AC', date: '2026-09-10', label: 'Facture fournitures',
  rationale: 'Facture PDF reçue le 10/09, fournisseur reconnu',
  lines: [{ account: '6011', debit: 5000000 }, { account: '4011', partner: 'papeterie', credit: 5000000 }]
}, { actor: { id: 'oracle', kind: 'ai' } });

// Plus tard, dans l'interface, un humain relit puis valide (ou corrige, ou supprime)
await compta.validate(brouillon.id, { actor: comptable });
```

Les crochets (`hooks`) servent à brancher un module Comptabilité ou une IA :

```js
createLedger({
  entity: { id: 'cortex' },
  hooks: {
    onProposal: (ecriture, acteur) => notifier('Écriture à valider', ecriture),
    beforeValidate: (ecriture, acteur) => { if (!ecriture.reference) throw new Error('Pièce justificative manquante'); },
    afterValidate: (ecriture) => indexer(ecriture),
    afterClose: (bilan) => archiver(bilan)
  }
});
```

`beforeValidate` s'exécute dans la transaction : une erreur bloque la
validation sans consommer de numéro.

### Correction, clôture

```js
await compta.reverse(ecriture.id, { actor: comptable });  // contre-passation (lettrée ou pointée : délettrer avant)
const cloture = await compta.closeFiscalYear('2026', { actor: comptable, allocateResult: true });
cloture.result;        // bénéfice (+) ou perte (−)
cloture.closingEntry;  // OD au 31/12 : classes 6-8 → 131 / 139
cloture.openingEntry;  // AN au 01/01/2027 : classes 1-5, résultat affecté en 121 / 1291
```

Pour clôturer, il faut que l'exercice suivant soit ouvert et qu'aucun
brouillon ne reste. Les comptes lettrables sont reportés pièce par pièce, ce
qui permet de continuer le lettrage sur l'exercice suivant. Les engagements
hors bilan (classe 9) ne sont pas reportés.

### États

```js
await compta.trialBalance({ fiscalYear: '2026' });                 // balance générale, totaux par classe
await compta.generalLedger({ fiscalYear: '2026', accounts: ['41'], byPartner: true }); // grand livre auxiliaire
await compta.journalReport('VT', { fiscalYear: '2026' });
await compta.balanceSheet({ fiscalYear: '2026' });   // rubriques AD…BZ / CA…DZ, brut, amortissements, net
await compta.incomeStatement({ fiscalYear: '2026' }); // TA…XI : marge, valeur ajoutée, EBE, résultat net
await compta.vatReport({ from: '2026-09-01', to: '2026-09-30' }); // collectée, déductible, à reverser
```

Dans le bilan SYSCOHADA, un compte de tiers ou de trésorerie (classes 4 et 5)
va à l'actif ou au passif selon le sens de son solde. Les amortissements et
dépréciations (28, 29, 39, 49, 59) sont déduits de la rubrique qu'ils
corrigent. Un compte qu'aucune rubrique ne reconnaît (par exemple une créance
au solde anormalement créditeur) apparaît dans `unclassified` et compte dans
les totaux : le bilan reste équilibré et l'anomalie est visible.

Pour le SYSCEBNL, le bilan reprend les groupes du plan associatif (dotations,
fonds affectés, fonds reportés…) et le compte de résultat a une ligne par
groupe (60, 61… 70, 71…), puis les sous-totaux et l'excédent ou le déficit.

### Rapprochement bancaire

```js
await compta.importStatement({ account: '5211', lines: [
  { id: 'releve-0912-1', date: '2026-09-12', label: 'VIR FAMILLE KABILA', amount: 11600000 }
] }, { actor: comptable });
await compta.autoMatchStatement('5211', { actor: comptable });  // même montant, ±3 jours, sans ambiguïté
await compta.matchStatement(['releve-0915-2'], [ligneA, ligneB], { actor: comptable }); // sommes égales
const etat = await compta.bankReconciliation('5211', { date: '2026-09-30', statementBalance: 123450000 });
etat.balanced; // solde comptable ± opérations non pointées = solde du relevé
```

## Plans et taxes

| Plan | Comptes | Usage |
| --- | --- | --- |
| `syscohada` | 1 134 | entreprises, SYSCOHADA révisé |
| `syscebnl` | 453 (+ 91 groupes) | associations, ONG, fondations |
| `createChart({ accounts, profile })` | les tiens | plan personnalisé |

Si un compte manque, `addAccount()` l'ajoute pour l'entité. C'est le cas des
comptes bancaires détaillés : Odoo les crée à la volée sous 521.
`loadTaxes('cd', plan)` renvoie les 13 taxes de la RDC (TVA 16 % ventes,
services, immobilisations, importations en autoliquidation ; 0 % export,
exonéré). `computeTax(base, taxe)` rend les lignes d'écriture.

Les plans et les taxes proviennent d'Odoo (LGPL-3, Copyright Odoo S.A.) et
sont stockés comme fichiers de données séparés. Ils sont convertis sans
réécriture par `scripts/import-odoo.js`. Les sources d'origine et le texte de
la licence sont dans `data/source/`. Voir `NOTICE` pour le commit exact et les
empreintes.

## Stockage

Par défaut, les données sont gardées en mémoire. Pour Postgres, passe le même
pool qu'à `@astratra/store-postgres` :

```js
const { Pool } = require('pg');
const { createPostgresMigrationRunner } = require('@astratra/store-postgres');
const { createLedger, createPostgresLedgerStore, ledgerPostgresMigrations } = require('@astratra/ledger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await createPostgresMigrationRunner({ pool }).run(ledgerPostgresMigrations('ledger'));
const compta = createLedger({ entity: { id: 'ecole-lumiere' }, store: createPostgresLedgerStore({ pool }) });
```

Avec Postgres, chaque opération est une transaction SQL, sérialisée par
entité grâce à `pg_advisory_xact_lock`. La ligne de séquence est verrouillée
(`FOR UPDATE`) et le numéro est `UNIQUE` par entité. Toutes les mises à jour
d'écriture portent `WHERE status = 'draft'`.

Un autre stockage (Mongo, fichier…) n'a qu'à implémenter `LedgerStore`
(voir `index.d.ts`) : `transaction(entityId, fn)` tout ou rien et sérialisée,
`read(entityId, fn)`, et les méthodes de `LedgerStoreAccess`.

## Limites connues

- Il n'y a pas d'immobilisations (plan d'amortissement) ni de paie : les
  dotations et les salaires se passent comme des écritures.
- La TVA porte sur la RDC uniquement. Les autres pays OHADA (taxes `l10n_cm`,
  `l10n_ci`, `l10n_sn`… dans Odoo) peuvent être importés de la même façon.
- Le bilan et le compte de résultat suivent la présentation SYSCOHADA en
  rubriques, pas les liasses fiscales officielles avec leurs notes annexes.
- Pour un compte bancaire tenu en devise, le rapprochement compare les
  montants convertis en devise de tenue.
- En Postgres, l'immuabilité est garantie par le code du stockage. Si d'autres
  programmes écrivent dans les mêmes tables, ajoute un déclencheur SQL qui
  refuse `UPDATE` et `DELETE` sur les lignes `status = 'posted'`.
