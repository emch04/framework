import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Envoi, EvenementErreur } from '../src/envoi.ts';
import { demarrer, gestionnaireErreurs, intergiciel } from '../src/node.ts';
import { centraleParDefaut } from '../src/coeur.ts';
import { CONFIG, transportFactice } from './aides.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/processus.ts', import.meta.url));

/** Un faux backend HTTP qui garde les envois reçus. */
async function fauxBackend() {
  const envois: Array<{ cle: string | undefined; envoi: Envoi }> = [];
  const serveur = createServer((req, res) => {
    let corps = '';
    req.on('data', (m) => { corps += m; });
    req.on('end', () => {
      envois.push({ cle: req.headers['x-centrale-cle'] as string | undefined, envoi: JSON.parse(corps) });
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"recus":1}');
    });
  });
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const port = (serveur.address() as AddressInfo).port;
  return { adresse: `http://127.0.0.1:${port}`, envois, fermer: () => new Promise<void>((r) => serveur.close(() => r())) };
}

function lancer(cas: string, adresse: string, surSortie?: (enfant: ReturnType<typeof spawn>) => void) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resoudre) => {
    const enfant = spawn(process.execPath, [FIXTURE, cas], { env: { ...process.env, ADRESSE: adresse, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    enfant.stderr!.on('data', (m) => { stderr += m; });
    surSortie?.(enfant);
    enfant.on('exit', (code, signal) => resoudre({ code, signal, stderr }));
  });
}

const evenements = (envois: Array<{ envoi: Envoi }>) => envois.flatMap((e) => e.envoi.evenements);

test('Express : intergiciel (idRequete, durée, statut, miette) et gestionnaire d\'erreurs', async () => {
  const t = transportFactice();
  const c = demarrer({ ...CONFIG, capterErreurs: false, viderALaSortie: false }, t.transport, { minuterie: false });
  const app = express();
  app.use(c.intergiciel());
  const routeur = express.Router();
  routeur.get('/:id/notes', (req, res) => {
    c.miette('autre', `lecture des notes de ${req.params.id}`);
    res.json({ ok: true });
  });
  routeur.get('/:id/plantage', async (_req, _res, next) => {
    c.miette('autre', 'avant le plantage');
    await new Promise((r) => setTimeout(r, 5));
    next(new Error('lecture impossible pour prof@ecole.fr'));
  });
  routeur.get('/:id/absent', (_req, _res, next) => {
    next(Object.assign(new Error('introuvable'), { status: 404 }));
  });
  app.use('/eleves', routeur);
  app.use(c.gestionnaireErreurs());
  const serveur = app.listen(0);
  const base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/eleves/123/notes?token=abc`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    const ko = await fetch(`${base}/eleves/456/plantage`, { headers: { 'X-Request-Id': 'req-abc-1' } });
    assert.equal(ko.status, 500);
    assert.equal(ko.headers.get('x-request-id'), 'req-abc-1');
    const absent = await fetch(`${base}/eleves/7/absent`);
    assert.equal(absent.status, 404);
    // Une miette par requête terminée, dans le fil global.
    c.erreur(new Error('après les requêtes'));
    await c.vider();
  } finally {
    serveur.close();
    c.debrancher();
  }
  const evs = t.envois().flatMap((e) => e.evenements) as EvenementErreur[];
  assert.equal(t.envois()[0].sdk.nom, '@astratra/centrale/node');
  assert.equal(t.envois()[0].contexte.plateforme, 'serveur');
  assert.equal(evs.length, 3);
  const [plantage, absent, apres] = evs;

  assert.equal(plantage.niveau, 'erreur');
  assert.match(plantage.exception.message, /\[email\]/);
  assert.equal(plantage.requete?.methode, 'GET');
  assert.equal(plantage.requete?.route, '/eleves/:id/plantage');
  assert.equal(plantage.requete?.statut, 500);
  assert.equal(plantage.requete?.idRequete, 'req-abc-1');
  assert.equal(typeof plantage.requete?.dureeMs, 'number');
  // Le fil d'Ariane de l'erreur est celui de SA requête (portée asynchrone), pas celui des autres.
  assert.deepEqual(plantage.filAriane?.map((m) => m.message), ['avant le plantage']);
  assert.equal(plantage.exception.pile[0].app, true);
  assert.match(plantage.exception.pile[0].fichier, /^test\/node\.test\.ts$|node\.test\.ts$/);

  assert.equal(absent.niveau, 'avertissement');
  assert.equal(absent.requete?.statut, 404);
  assert.equal(absent.requete?.route, '/eleves/:id/absent');

  const fil = apres.filAriane!.filter((m) => m.categorie === 'requete');
  assert.deepEqual(fil.map((m) => m.message), ['GET /eleves/:id/notes', 'GET /eleves/:id/plantage', 'GET /eleves/:id/absent']);
  assert.deepEqual(fil.map((m) => m.donnees?.statut), [200, 500, 404]);
  assert.equal(fil[1].donnees?.idRequete, 'req-abc-1');
  assert.ok(!t.requetes.some((r) => r.corps.includes('token=abc')));
});

test('Express : intergiciel et gestionnaire autonomes sans demarrer ne cassent rien', async () => {
  const app = express();
  app.use(intergiciel(undefined));
  app.get('/x', () => { throw new Error('x'); });
  app.use(gestionnaireErreurs(undefined));
  const serveur = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${(serveur.address() as AddressInfo).port}/x`);
    assert.equal(r.status, 500);
  } finally {
    serveur.close();
  }
});

test('demarrer : instance par défaut, debrancher, desactive', () => {
  const c = demarrer({ ...CONFIG, capterErreurs: false, viderALaSortie: false }, transportFactice().transport, { minuterie: false });
  assert.equal(centraleParDefaut(), c);
  c.debrancher();
  assert.equal(centraleParDefaut(), undefined);
  const avant = process.listenerCount('uncaughtException');
  const inactive = demarrer({ ...CONFIG, desactive: true });
  assert.equal(inactive.actif, false);
  assert.equal(process.listenerCount('uncaughtException'), avant);
});

test('exception non attrapée : enregistrée en fatal et envoyée, puis comportement normal (pile, code 1)', async () => {
  const backend = await fauxBackend();
  try {
    const { code, stderr } = await lancer('exception', backend.adresse);
    assert.equal(code, 1);
    assert.match(stderr, /exception non attrapée/);
    const erreurs = evenements(backend.envois).filter((e) => e.type === 'erreur') as EvenementErreur[];
    assert.equal(erreurs.length, 1);
    assert.equal(erreurs[0].niveau, 'fatal');
    assert.equal(backend.envois[0].cle, 'clj_pub_enfant1234567890');
    assert.equal(backend.envois[0].envoi.contexte.version, '9.9.9');
    assert.equal(erreurs[0].exception.pile[0].app, true);
    assert.match(erreurs[0].exception.pile[0].fichier, /processus\.ts$/);
  } finally {
    await backend.fermer();
  }
});

test('promesse rejetée sans gestionnaire : Node plante toujours (mode par défaut), erreur fatale envoyée', async () => {
  const backend = await fauxBackend();
  try {
    const { code } = await lancer('rejet', backend.adresse);
    assert.equal(code, 1);
    const erreurs = evenements(backend.envois).filter((e) => e.type === 'erreur') as EvenementErreur[];
    assert.equal(erreurs.length, 1);
    assert.equal(erreurs[0].exception.message, 'rejet sans gestionnaire');
    assert.equal(erreurs[0].niveau, 'fatal');
  } finally {
    await backend.fermer();
  }
});

test('promesse rejetée avec un autre écouteur : pas de plantage, erreur enregistrée et vidée à la sortie', async () => {
  const backend = await fauxBackend();
  try {
    const { code } = await lancer('rejet-gere', backend.adresse);
    assert.equal(code, 0);
    const erreurs = evenements(backend.envois).filter((e) => e.type === 'erreur') as EvenementErreur[];
    assert.equal(erreurs.length, 1);
    assert.equal(erreurs[0].niveau, 'erreur');
    assert.equal(erreurs[0].etiquettes?.origine, 'unhandledRejection');
  } finally {
    await backend.fermer();
  }
});

test('sortie normale : beforeExit vide la file', async () => {
  const backend = await fauxBackend();
  try {
    const { code } = await lancer('sortie', backend.adresse);
    assert.equal(code, 0);
    const types = evenements(backend.envois).map((e) => e.type).sort();
    assert.deepEqual(types, ['erreur', 'usage']);
  } finally {
    await backend.fermer();
  }
});

test('SIGTERM : la file est vidée, puis le processus s\'arrête normalement', async () => {
  const backend = await fauxBackend();
  try {
    const { signal } = await lancer('signal', backend.adresse, (enfant) => {
      enfant.stdout!.on('data', (m) => { if (String(m).includes('pret')) enfant.kill('SIGTERM'); });
    });
    assert.equal(signal, 'SIGTERM');
    assert.deepEqual(evenements(backend.envois).map((e) => e.type), ['usage']);
  } finally {
    await backend.fermer();
  }
});

test('backend injoignable : le processus sort quand même, sans exception', async () => {
  const { code, stderr } = await lancer('sortie', 'http://127.0.0.1:9');
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /centrale/i);
});
