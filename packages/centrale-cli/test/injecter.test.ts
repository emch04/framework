import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { debugIdDe, injecterDossier, injecterFichier, ligneEnregistrement, pointDInsertion, GLOBALE } from '../src/injecter.ts';
import { decalerColonnes, ecrireVlq, lireVlq } from '../src/vlq.ts';
import { copieDesFixtures, origine, segments } from './aides.ts';

test('VLQ : aller-retour sur des valeurs positives, négatives et grandes', () => {
  for (const v of [0, 1, -1, 15, -16, 16, 31, 32, -33, 1000, -123456, 2 ** 30]) {
    const texte = ecrireVlq(v);
    assert.deepEqual(lireVlq(texte, 0), [v, texte.length], String(v));
  }
  assert.equal(ecrireVlq(16), 'gB');
  assert.deepEqual(lireVlq('AACA', 2), [1, 3]);
  assert.throws(() => lireVlq('g', 0), /tronqué/);
  assert.throws(() => lireVlq('!', 0), /invalide/);
});

test('decalerColonnes ne corrige que le premier segment concerné de la ligne', () => {
  const mappings = 'AAAA,KAAK,KAAK;AACA';
  const decale = decalerColonnes(mappings, 0, 5, 100);
  assert.deepEqual(segments(decale)[0].map((s) => s[0]), [0, 105, 110]);
  assert.deepEqual(segments(decale)[1], segments(mappings)[1], 'les autres lignes ne bougent pas');
  assert.equal(decalerColonnes(mappings, 7, 0, 3), mappings, 'ligne absente : rien à faire');
});

test('le debugId est un UUID stable, tiré du contenu', () => {
  const id = debugIdDe('console.log(1)');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(debugIdDe('console.log(1)'), id);
  assert.notEqual(debugIdDe('console.log(2)'), id);
});

test('point d\'insertion : après #!, "use strict" et "use client", jamais au milieu d\'une expression', () => {
  assert.equal(pointDInsertion('var a=1'), 0);
  assert.equal(pointDInsertion('#!/usr/bin/env node\nvar a=1'), 20);
  assert.equal(pointDInsertion('"use strict";var a=1'), 13);
  assert.equal(pointDInsertion('/*! licence */\n\'use client\'\nexport default 1'), 27);
  assert.equal(pointDInsertion('"use strict";"use client";x()'), 26);
  assert.equal(pointDInsertion('"a"+b'), 0, 'une chaîne suivie d\'un opérateur n\'est pas une directive');
});

test('injecter : ligne d\'enregistrement en tête, commentaire en fin, debug_id dans la carte, colonnes recalées', () => {
  const dossier = copieDesFixtures();
  const js = join(dossier, 'panier.min.js');
  const carte = join(dossier, 'panier.min.js.map');
  const avant = readFileSync(js, 'utf8');
  const carteAvant = JSON.parse(readFileSync(carte, 'utf8'));
  const attendu = debugIdDe(avant);

  const [r] = injecterDossier(dossier);
  assert.equal(r.etat, 'injecte');
  assert.ok('debugId' in r && r.debugId === attendu);

  const apres = readFileSync(js, 'utf8');
  const ligne = ligneEnregistrement(attendu);
  assert.ok(apres.startsWith(ligne + 'export function calculerTotal'), 'sur la même ligne : les numéros de ligne ne bougent pas');
  assert.ok(apres.trimEnd().endsWith(`//# debugId=${attendu}`));
  assert.equal(apres.split('\n').length, avant.split('\n').length + 1, 'seulement le commentaire de fin en plus');

  const carteApres = JSON.parse(readFileSync(carte, 'utf8'));
  assert.equal(carteApres.debug_id, attendu);
  assert.equal(carteApres.debugId, attendu);
  // « new TypeError » pointe toujours au même endroit du source d'origine.
  const colonneAvant = avant.indexOf('new TypeError');
  const colonneApres = apres.indexOf('new TypeError');
  assert.equal(colonneApres, colonneAvant + ligne.length);
  assert.deepEqual(origine(carteApres.mappings, 0, colonneApres), origine(carteAvant.mappings, 0, colonneAvant));
  assert.deepEqual(origine(carteApres.mappings, 0, colonneApres), [11, 10], 'ligne 12, colonne 11 de src/panier.js');
});

test('injecter est idempotent : relancer ne double rien', () => {
  const dossier = copieDesFixtures();
  const [premier] = injecterDossier(dossier);
  const js = readFileSync(join(dossier, 'panier.min.js'), 'utf8');
  const carte = readFileSync(join(dossier, 'panier.min.js.map'), 'utf8');
  const [second] = injecterDossier(dossier);
  assert.equal(second.etat, 'deja');
  assert.ok('debugId' in premier && 'debugId' in second && premier.debugId === second.debugId);
  assert.equal(readFileSync(join(dossier, 'panier.min.js'), 'utf8'), js);
  assert.equal(readFileSync(join(dossier, 'panier.min.js.map'), 'utf8'), carte);
  assert.equal(js.split(GLOBALE).length - 1, 3, 'une seule ligne d\'enregistrement');
});

test('le même build donne le même identifiant dans deux dossiers', () => {
  const [a] = injecterDossier(copieDesFixtures());
  const [b] = injecterDossier(copieDesFixtures());
  assert.ok('debugId' in a && 'debugId' in b && a.debugId === b.debugId);
});

test('le fichier injecté s\'exécute, enregistre son identifiant, et ses erreurs pointent au bon endroit', async () => {
  const dossier = copieDesFixtures();
  const [r] = injecterDossier(dossier);
  assert.ok('debugId' in r);
  const js = join(dossier, 'panier.min.js');
  const module = await import(pathToFileURL(js).href);
  const ids = (globalThis as Record<string, unknown>)[GLOBALE] as Record<string, string>;
  const cle = Object.keys(ids).find((pile) => pile.includes(pathToFileURL(js).href));
  assert.ok(cle, 'la pile capturée contient l\'adresse du fichier');
  assert.equal(ids[cle], r.debugId);

  let pile = '';
  try { module.payer({ articles: [{ nom: 'stylo', quantite: 2 }] }); } catch (e) { pile = (e as Error).stack ?? ''; }
  const position = new RegExp(`${pathToFileURL(js).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(\\d+)`).exec(pile);
  assert.ok(position, pile);
  const carte = JSON.parse(readFileSync(`${js}.map`, 'utf8'));
  assert.deepEqual(origine(carte.mappings, Number(position[1]) - 1, Number(position[2]) - 1), [11, 10]);
});

test('une carte sans JavaScript texte (bytecode Hermes) reçoit quand même un identifiant stable', () => {
  const dossier = copieDesFixtures();
  mkdirSync(join(dossier, 'hermes'));
  const carte = join(dossier, 'hermes', 'index.android.bundle.map');
  writeFileSync(carte, JSON.stringify({ version: 3, sources: ['a.js'], names: [], mappings: 'AAAA' }));
  writeFileSync(join(dossier, 'hermes', 'index.android.bundle.hbc'), Buffer.from([0xc6, 0x1f, 0xbc, 0x03]));
  writeFileSync(join(dossier, 'style.css.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
  const resultats = injecterDossier(dossier);
  const seule = resultats.find((r) => r.etat === 'carte-seule');
  assert.ok(seule && 'debugId' in seule);
  assert.equal(JSON.parse(readFileSync(carte, 'utf8')).debug_id, seule.debugId);
  assert.equal(resultats.filter((r) => r.etat === 'carte-seule').length, 1, 'les cartes CSS sont ignorées');
  const encore = injecterDossier(dossier).find((r) => r.etat === 'carte-seule');
  assert.ok(encore && 'debugId' in encore && encore.debugId === seule.debugId);
});

test('un JS sans carte est laissé intact', () => {
  const dossier = copieDesFixtures();
  writeFileSync(join(dossier, 'seul.js'), 'console.log(1)\n');
  const r = injecterFichier(join(dossier, 'seul.js'));
  assert.equal(r.etat, 'sans-carte');
  assert.equal(readFileSync(join(dossier, 'seul.js'), 'utf8'), 'console.log(1)\n');
});
