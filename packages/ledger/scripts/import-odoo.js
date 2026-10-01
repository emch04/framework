#!/usr/bin/env node
/**
 * Conversion reproductible des plans comptables OHADA d'Odoo en JSON.
 *
 *   node scripts/import-odoo.js          relit data/source/ et régénère data/charts + data/taxes
 *   node scripts/import-odoo.js --fetch  retélécharge d'abord les fichiers au commit épinglé
 *
 * Les fichiers d'origine sont sous LGPL-3 (Copyright Odoo S.A.) : on les garde
 * tels quels dans data/source/, et la conversion ne fait que changer le format.
 * Aucun libellé n'est réécrit : le français et l'anglais d'origine sont repris
 * à l'identique, un libellé français absent reste absent.
 *
 * Le script n'a aucune dépendance et inscrit l'empreinte SHA-256 de chaque
 * source dans le JSON produit ; les tests vérifient que data/source/ et les
 * JSON concordent, donc un fichier retouché à la main se voit.
 */
/* global fetch */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEPOT = 'odoo/odoo';
const BRANCHE = '20.0';
const COMMIT = '28ac90563f7239aef8fea6f20494adbcdd104236';
const RACINE = path.join(__dirname, '..', 'data');
const DOSSIER_SOURCE = path.join(RACINE, 'source');

const SOURCES = [
  { fichier: 'account.account-syscohada.csv', chemin: 'addons/l10n_syscohada/data/template/account.account-syscohada.csv' },
  { fichier: 'account.account-syscebnl.csv', chemin: 'addons/l10n_syscohada/data/template/account.account-syscebnl.csv' },
  { fichier: 'account.account.group-syscebnl.csv', chemin: 'addons/l10n_syscohada/data/template/account.account.group-syscebnl.csv' },
  { fichier: 'account.tax-cd.csv', chemin: 'addons/l10n_cd/data/template/account.tax-cd.csv' },
  { fichier: 'account.tax.group-cd.csv', chemin: 'addons/l10n_cd/data/template/account.tax.group-cd.csv' },
  { fichier: 'account.tax-cd_syscebnl.csv', chemin: 'addons/l10n_cd/data/template/account.tax-cd_syscebnl.csv' },
  { fichier: 'account.tax.group-cd_syscebnl.csv', chemin: 'addons/l10n_cd/data/template/account.tax.group-cd_syscebnl.csv' },
  { fichier: 'LICENSE', chemin: 'LICENSE' }
];

function urlBrute(chemin) {
  return `https://raw.githubusercontent.com/${DEPOT}/${COMMIT}/${chemin}`;
}

function empreinte(contenu) {
  return crypto.createHash('sha256').update(contenu).digest('hex');
}

/** Lecteur CSV RFC 4180 : guillemets doublés, virgules et retours à la ligne entre guillemets. */
function lireCsv(texte) {
  const lignes = [];
  let ligne = [];
  let champ = '';
  let entreGuillemets = false;
  for (let i = 0; i < texte.length; i += 1) {
    const c = texte[i];
    if (entreGuillemets) {
      if (c === '"' && texte[i + 1] === '"') { champ += '"'; i += 1; }
      else if (c === '"') entreGuillemets = false;
      else champ += c;
    } else if (c === '"') entreGuillemets = true;
    else if (c === ',') { ligne.push(champ); champ = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texte[i + 1] === '\n') i += 1;
      ligne.push(champ); lignes.push(ligne); ligne = []; champ = '';
    } else champ += c;
  }
  if (champ !== '' || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  const [entete, ...corps] = lignes.filter((l) => l.length > 1 || l[0] !== '');
  return corps.map((valeurs) => Object.fromEntries(entete.map((nom, index) => [nom, valeurs[index] ?? ''])));
}

function libelles(ligne, champ = 'name') {
  const resultat = { en: ligne[champ] };
  if (ligne[`${champ}@fr`]) resultat.fr = ligne[`${champ}@fr`];
  return resultat;
}

function convertirComptes(lignes) {
  return lignes.map((ligne) => {
    const compte = {
      code: ligne.code,
      labels: libelles(ligne),
      type: ligne.account_type,
      reconcile: ligne.reconcile === 'True',
      sourceId: ligne.id
    };
    if (ligne.non_trade === 'True') compte.nonTrade = true;
    return compte;
  });
}

function convertirGroupes(lignes) {
  return lignes.map((ligne) => ({
    prefix: ligne.code_prefix_start,
    ...(ligne.code_prefix_end ? { prefixEnd: ligne.code_prefix_end } : {}),
    labels: libelles(ligne),
    sourceId: ligne.id
  }));
}

/**
 * Une taxe Odoo occupe plusieurs lignes CSV : la première porte la taxe, les
 * suivantes (id vide) ses lignes de répartition (base / taxe, facture / avoir).
 */
function convertirTaxes(lignes) {
  const taxes = [];
  for (const ligne of lignes) {
    if (ligne.id) {
      const taxe = {
        id: ligne.id,
        name: ligne.name,
        labels: { en: ligne.description, ...(ligne['description@fr'] ? { fr: ligne['description@fr'] } : {}) },
        active: ligne.active === 'True',
        amount: ligne.amount,
        amountType: ligne.amount_type || 'percent',
        use: ligne.type_tax_use,
        group: ligne.tax_group_id,
        repartition: []
      };
      if (ligne['name@fr']) taxe.nameFr = ligne['name@fr'];
      if (ligne.original_tax_ids) taxe.replaces = ligne.original_tax_ids;
      taxes.push(taxe);
    }
    const taxe = taxes[taxes.length - 1];
    const repartition = {
      kind: ligne['repartition_line_ids/repartition_type'],
      document: ligne['repartition_line_ids/document_type'],
      factorPercent: ligne['repartition_line_ids/factor_percent'] ? Number(ligne['repartition_line_ids/factor_percent']) : 100
    };
    const compte = ligne['repartition_line_ids/account_id'];
    if (compte) repartition.accountSourceId = compte;
    const tag = ligne['repartition_line_ids/tag_ids'];
    if (tag) repartition.reportTag = tag;
    taxe.repartition.push(repartition);
  }
  return taxes;
}

/** Remplace les identifiants Odoo des comptes (pcg_4431) par les codes (4431). */
function resoudreComptes(taxes, comptes) {
  const parIdentifiant = new Map(comptes.map((compte) => [compte.sourceId, compte.code]));
  for (const taxe of taxes) {
    for (const ligne of taxe.repartition) {
      if (!ligne.accountSourceId) continue;
      const code = parIdentifiant.get(ligne.accountSourceId);
      if (!code) throw new Error(`Compte ${ligne.accountSourceId} introuvable pour la taxe ${taxe.id}.`);
      ligne.account = code;
      delete ligne.accountSourceId;
    }
  }
  return taxes;
}

async function telecharger() {
  fs.mkdirSync(DOSSIER_SOURCE, { recursive: true });
  for (const source of SOURCES) {
    const reponse = await fetch(urlBrute(source.chemin));
    if (!reponse.ok) throw new Error(`Téléchargement impossible (${reponse.status}) : ${source.chemin}`);
    fs.writeFileSync(path.join(DOSSIER_SOURCE, source.fichier), Buffer.from(await reponse.arrayBuffer()));
    process.stdout.write(`téléchargé ${source.chemin}\n`);
  }
}

function lireSource(fichier) {
  return fs.readFileSync(path.join(DOSSIER_SOURCE, fichier));
}

function provenance(fichiers) {
  return {
    repository: `https://github.com/${DEPOT}`,
    branch: BRANCHE,
    commit: COMMIT,
    license: 'LGPL-3.0-only',
    copyright: 'Odoo S.A.',
    files: fichiers.map((fichier) => {
      const source = SOURCES.find((s) => s.fichier === fichier);
      return { path: source.chemin, url: urlBrute(source.chemin), sha256: empreinte(lireSource(fichier)) };
    })
  };
}

function ecrire(relatif, objet) {
  const cible = path.join(RACINE, relatif);
  fs.writeFileSync(cible, `${JSON.stringify(objet, null, 1)}\n`);
  process.stdout.write(`écrit data/${relatif}\n`);
}

/** Construit les trois fichiers JSON à partir de data/source/, sans rien écrire. */
function construire() {
  const syscohada = convertirComptes(lireCsv(lireSource('account.account-syscohada.csv').toString('utf8')));
  const syscebnl = convertirComptes(lireCsv(lireSource('account.account-syscebnl.csv').toString('utf8')));
  const groupesSyscebnl = convertirGroupes(lireCsv(lireSource('account.account.group-syscebnl.csv').toString('utf8')));

  const fichiers = {};
  fichiers['charts/syscohada.json'] = {
    id: 'syscohada',
    name: 'SYSCOHADA - Revised',
    source: provenance(['account.account-syscohada.csv']),
    accounts: syscohada
  };
  fichiers['charts/syscebnl.json'] = {
    id: 'syscebnl',
    name: 'SYSCEBNL',
    source: provenance(['account.account-syscebnl.csv', 'account.account.group-syscebnl.csv']),
    groups: groupesSyscebnl,
    accounts: syscebnl
  };

  const groupes = (fichier) => lireCsv(lireSource(fichier).toString('utf8')).map((ligne) => ({ id: ligne.id, labels: libelles(ligne) }));
  fichiers['taxes/cd.json'] = {
    country: 'CD',
    source: provenance(['account.tax-cd.csv', 'account.tax.group-cd.csv', 'account.tax-cd_syscebnl.csv', 'account.tax.group-cd_syscebnl.csv']),
    charts: {
      syscohada: {
        groups: groupes('account.tax.group-cd.csv'),
        taxes: resoudreComptes(convertirTaxes(lireCsv(lireSource('account.tax-cd.csv').toString('utf8'))), syscohada)
      },
      syscebnl: {
        groups: groupes('account.tax.group-cd_syscebnl.csv'),
        taxes: resoudreComptes(convertirTaxes(lireCsv(lireSource('account.tax-cd_syscebnl.csv').toString('utf8'))), syscebnl)
      }
    }
  };
  return fichiers;
}

async function main() {
  if (process.argv.includes('--fetch')) await telecharger();
  for (const [relatif, contenu] of Object.entries(construire())) ecrire(relatif, contenu);
}

if (require.main === module) {
  main().catch((erreur) => {
    process.stderr.write(`${erreur.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { construire, empreinte, SOURCES, COMMIT };
