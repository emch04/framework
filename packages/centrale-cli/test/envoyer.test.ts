import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { injecterDossier } from '../src/injecter.ts';
import { cartesDe, declarerDeploiement, envoyerCartes, ErreurCentrale } from '../src/envoyer.ts';
import { executer } from '../src/cli.ts';
import { copieDesFixtures, fetchFactice } from './aides.ts';

const JETON = 'clj_dep_' + 'a'.repeat(40);

/** Un backend factice : il connaît `connues` et enregistre tout ce qu'on lui envoie. */
function backend(connues: string[] = []) {
  const recues: string[] = [];
  const faux = fetchFactice((url, corps) => {
    const c = corps as { debugIds?: string[]; cartes?: Array<{ debugId: string }> };
    if (url.endsWith('/v1/cartes/connues')) return { statut: 200, json: { connues: (c.debugIds ?? []).filter((id) => connues.includes(id) || recues.includes(id)) } };
    if (url.endsWith('/v1/cartes')) {
      const ids = (c.cartes ?? []).map((x) => x.debugId);
      recues.push(...ids);
      return { statut: 201, json: { enregistrees: ids, dejaConnues: [], refusees: [] } };
    }
    return { statut: 201, json: { deploiement: corps } };
  });
  const attentes: number[] = [];
  const connexion = { adresse: 'https://centrale.exemple.fr/', jeton: JETON, fetch: faux.fetch, attendre: async (ms: number) => { attentes.push(ms); } };
  return { ...faux, recues, attentes, connexion };
}

/** Un dossier avec la carte d'exemple plus deux cartes de plus. */
function dossierDeTrois() {
  const dossier = copieDesFixtures();
  injecterDossier(dossier);
  for (const nom of ['a', 'b']) writeFileSync(join(dossier, `${nom}.js.map`), JSON.stringify({ version: 3, sources: [`${nom}.ts`], names: [], mappings: 'AAAA', debug_id: `00000000-0000-4000-8000-00000000000${nom === 'a' ? 1 : 2}` }));
  return dossier;
}

test('cartesDe liste les cartes, leur fichier relatif et leur identifiant', () => {
  const dossier = dossierDeTrois();
  const cartes = cartesDe(dossier);
  assert.deepEqual(cartes.map((c) => c.fichier), ['a.js', 'b.js', 'panier.min.js']);
  assert.ok(cartes.every((c) => c.injecte));
  const sansId = copieDesFixtures();
  const [brute] = cartesDe(sansId);
  assert.equal(brute.injecte, false, 'sans injection : identifiant tiré du contenu');
  assert.equal(cartesDe(sansId)[0].debugId, brute.debugId, 'et stable');
});

test('envoyer-cartes : jeton porteur, cartes déjà connues sautées, le reste par lots compressés', async () => {
  const dossier = dossierDeTrois();
  const b = backend(['00000000-0000-4000-8000-000000000001']);
  const bilan = await envoyerCartes(b.connexion, { dossier, version: '2.14.0', lotOctets: 1 });
  assert.deepEqual(bilan.dejaConnues, ['00000000-0000-4000-8000-000000000001']);
  assert.equal(bilan.envoyees.length, 2);
  const envois = b.requetes.filter((r) => r.url.endsWith('/v1/cartes'));
  assert.equal(envois.length, 2, 'un lot par carte quand le lot est petit');
  assert.equal(b.requetes[0].url, 'https://centrale.exemple.fr/v1/cartes/connues');
  assert.equal(b.requetes[0].entetes.Authorization, `Bearer ${JETON}`);
  assert.equal(envois[0].entetes['Content-Encoding'], undefined, 'petit corps : pas de compression');
  const panier = envois.map((r) => (r.corps as { cartes: Array<{ fichier: string; carte: string }>; version: string })).find((c) => c.cartes[0].fichier === 'panier.min.js');
  assert.ok(panier);
  assert.equal(panier.version, '2.14.0');
  assert.ok(JSON.parse(panier.cartes[0].carte).sourcesContent, 'la carte part entière');

  // Relancer : tout est connu, rien ne repart (reprise après coupure).
  const encore = await envoyerCartes(b.connexion, { dossier, version: '2.14.0' });
  assert.equal(encore.envoyees.length, 0);
  assert.equal(encore.dejaConnues.length, 3);
});

test('les gros lots partent compressés en gzip', async () => {
  const dossier = copieDesFixtures();
  writeFileSync(join(dossier, 'gros.js.map'), JSON.stringify({ version: 3, sources: ['g.ts'], names: [], mappings: 'AAAA;'.repeat(2000) }));
  const b = backend();
  await envoyerCartes(b.connexion, { dossier, version: '1' });
  const envoi = b.requetes.find((r) => r.url.endsWith('/v1/cartes'));
  assert.equal(envoi?.entetes['Content-Encoding'], 'gzip');
  assert.equal((envoi?.corps as { cartes: unknown[] }).cartes.length, 2, 'un seul lot');
});

test('reprise : coupure, 503 et 429 sont réessayés avec recul, Retry-After respecté', async () => {
  const dossier = copieDesFixtures();
  const b = backend();
  b.reponses.push(new TypeError('fetch failed'), { statut: 503 }, { statut: 429, entetes: { 'Retry-After': '7' } });
  const bilan = await envoyerCartes(b.connexion, { dossier, version: '1' });
  assert.equal(bilan.envoyees.length, 1);
  assert.deepEqual(b.attentes, [1000, 2000, 7000]);
});

test('un jeton refusé (401) arrête tout, sans réessayer', async () => {
  const dossier = copieDesFixtures();
  const b = backend();
  b.reponses.push({ statut: 401, json: { message: 'Jeton de déploiement inconnu ou révoqué.' } });
  await assert.rejects(envoyerCartes(b.connexion, { dossier, version: '1' }), (e: unknown) => e instanceof ErreurCentrale && e.statut === 401 && /révoqué/.test(e.message));
  assert.equal(b.requetes.length, 1);
});

test('déclarer un déploiement', async () => {
  const b = backend();
  await declarerDeploiement(b.connexion, { version: '2.14.0', commit: 'abc123', depot: 'kongo/scolaris', environnement: 'production' });
  assert.equal(b.requetes[0].url, 'https://centrale.exemple.fr/v1/deploiements');
  assert.deepEqual(b.requetes[0].corps, { version: '2.14.0', commit: 'abc123', depot: 'kongo/scolaris', environnement: 'production' });
});

test('la commande : variables d\'environnement, options et codes de sortie', async () => {
  const lignes: string[] = [];
  const sorties = { ecrire: (t: string) => lignes.push(t), erreur: (t: string) => lignes.push(`! ${t}`) };
  const b = backend();
  const dossier = copieDesFixtures();

  assert.equal(await executer(['envoyer-cartes', dossier, '--version', '1'], { env: {}, sorties }), 2, 'sans jeton');
  assert.match(lignes.at(-1) ?? '', /CENTRALE_JETON/);
  assert.equal(await executer(['envoyer-cartes', dossier], { env: { CENTRALE_JETON: JETON, CENTRALE_ADRESSE: 'https://c.fr' }, sorties }), 2, 'sans version');
  assert.equal(await executer(['inconnue'], { sorties }), 2);
  assert.equal(await executer(['injecter', join(dossier, 'absent')], { sorties }), 2);

  assert.equal(await executer(['injecter', dossier], { sorties }), 0);
  assert.match(lignes.at(-1) ?? '', /^1 injecté/);
  assert.equal(await executer(['injecter', dossier], { sorties }), 0);
  assert.match(lignes.at(-1) ?? '', /^0 injecté\(s\), 1 déjà fait/);

  const env = { CENTRALE_JETON: JETON, CENTRALE_ADRESSE: 'https://centrale.exemple.fr' };
  assert.equal(await executer(['envoyer-cartes', dossier, '--version=2.0.0'], { env, sorties, connexion: { fetch: b.fetch, attendre: async () => {} } }), 0);
  assert.match(lignes.at(-1) ?? '', /^1 carte\(s\) envoyée/);
  assert.equal(await executer(['deploiement', '--version', '2.0.0', '--commit', 'deadbeef', '--depot', 'kongo/x'], { env, sorties, connexion: { fetch: b.fetch } }), 0);
  assert.deepEqual(b.requetes.at(-1)?.corps, { version: '2.0.0', commit: 'deadbeef', depot: 'kongo/x' });
  assert.equal(await executer(['deploiement', '--version', '2.0.0'], { env, sorties }), 2, 'sans commit');

  b.reponses.push({ statut: 401, json: { message: 'refusé' } });
  assert.equal(await executer(['deploiement', '--version', '2', '--commit', 'x'], { env, sorties, connexion: { fetch: b.fetch } }), 1);
  assert.match(lignes.at(-1) ?? '', /Échec : refusé/);
});
