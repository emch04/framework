import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerCentrale } from '../src/coeur.ts';
import type { EvenementErreur, EvenementSession } from '../src/envoi.ts';
import { demarrer } from '../src/expo.ts';
import type { AppStateRN } from '../src/expo.ts';
import { gabaritRequete, memoireLancement, suivreConsole, suivreRequetes, surveillerBlocages } from '../src/vigilance.ts';
import type { StockageCentrale } from '../src/vigilance.ts';
import { CONFIG, horloge, transportFactice } from './aides.ts';

/*
 * La surveillance renforcée : requêtes, console, gardien du fil principal, mémoire d'un lancement à l'autre,
 * alerte mémoire d'iOS.
 */

const evenements = (tr: ReturnType<typeof transportFactice>) => tr.envois().flatMap((e) => e.evenements);
const erreurs = (tr: ReturnType<typeof transportFactice>) => evenements(tr).filter((e) => e.type === 'erreur') as EvenementErreur[];

test('requêtes : gabarit, statut et durée dans le fil d’Ariane ; échecs signalés ; la Centrale et les annulations ignorées', async () => {
  const tr = transportFactice();
  const h = horloge();
  const c = creerCentrale(CONFIG, tr.transport, { minuterie: false, maintenant: h.maintenant });
  const reponses: Record<string, () => Promise<{ status: number }>> = {
    'https://api.exemple.fr/v1/titres/42?lang=fr': async () => { h.avancer(120); return { status: 200 }; },
    'https://api.exemple.fr/v1/aria/live': async () => ({ status: 503 }),
    'https://api.exemple.fr/v1/hors-ligne': async () => { throw new TypeError('Network request failed'); },
    'https://api.exemple.fr/v1/annulee': async () => { throw Object.assign(new Error('annulée'), { name: 'AbortError' }); },
    'https://centrale.exemple.fr/v1/envoi': async () => ({ status: 500 })
  };
  const cible: { fetch?: unknown } = { fetch: (adresse: string) => reponses[adresse]!() };
  const debrancher = suivreRequetes(c, cible, { adresseCentrale: CONFIG.adresse, maintenant: h.maintenant });
  const f = cible.fetch as (a: string, i?: { method?: string }) => Promise<{ status: number }>;
  assert.equal((await f('https://api.exemple.fr/v1/titres/42?lang=fr')).status, 200);
  await f('https://api.exemple.fr/v1/aria/live', { method: 'post' });
  await assert.rejects(f('https://api.exemple.fr/v1/hors-ligne'));
  await assert.rejects(f('https://api.exemple.fr/v1/annulee'));
  await f('https://centrale.exemple.fr/v1/envoi');
  const fil = c.filAriane();
  assert.deepEqual(fil.map((m) => [m.categorie, m.message, m.donnees?.statut]), [
    ['requete', 'GET api.exemple.fr/v1/titres/:id', 200],
    ['requete', 'POST api.exemple.fr/v1/aria/live', 503],
    ['requete', 'GET api.exemple.fr/v1/hors-ligne', 0]
  ]);
  assert.equal(fil[0]!.donnees?.dureeMs, 120);
  await c.vider();
  assert.deepEqual(erreurs(tr).map((e) => [e.exception.type, e.niveau, e.etiquettes?.statut]), [
    ['RequeteEchouee', 'erreur', '503'],
    ['RequeteSansReponse', 'erreur', '0']
  ]);
  debrancher();
  assert.equal(typeof cible.fetch, 'function');
  assert.equal(gabaritRequete('/v1/conversations/3f2a9c1e-0000-4000-8000-000000000001/messages'), '/v1/conversations/:id/messages');
});

test('console : error signalé une fois par message dans le délai, warn dans le fil d’Ariane seulement', async () => {
  const tr = transportFactice();
  const h = horloge();
  const c = creerCentrale(CONFIG, tr.transport, { minuterie: false, maintenant: h.maintenant });
  const ecrits: unknown[][] = [];
  const cons = { error: (...a: unknown[]) => { ecrits.push(a); }, warn: (...a: unknown[]) => { ecrits.push(a); } };
  suivreConsole(c, cons, h.maintenant);
  cons.error('Échec du rendu', { code: 3 });
  cons.error('Échec du rendu', { code: 3 });
  cons.warn('Attention');
  h.avancer(11_000);
  cons.error('Échec du rendu', { code: 3 });
  assert.equal(ecrits.length, 4, 'la console d’origine écrit toujours');
  await c.vider();
  assert.equal(erreurs(tr).length, 2);
  assert.equal(erreurs(tr)[0]!.niveau, 'avertissement');
  assert.ok(c.filAriane().some((m) => m.categorie === 'console' && m.message === 'Avertissement : Attention'));
});

test('gardien : un blocage au-delà de 2 s est signalé avec sa durée, une erreur au-delà de 5 s, rien en pause', async () => {
  const tr = transportFactice();
  const c = creerCentrale(CONFIG, tr.transport, { minuterie: false });
  let t = 0;
  const g = surveillerBlocages(c, { minuterie: false, maintenant: () => t });
  g.tic(500); g.tic(1000);
  g.tic(4000); // 2,5 s de retard
  g.tic(10_500); // 6 s de retard
  g.pause();
  g.tic(30_000);
  await c.vider();
  assert.deepEqual(erreurs(tr).map((e) => [e.exception.type, e.niveau, e.etiquettes?.duree_s]), [
    ['AppBloquee', 'avertissement', '2.5'],
    ['AppBloquee', 'erreur', '6']
  ]);
});

function memoireVive(): StockageCentrale & { valeurs: Map<string, string> } {
  const valeurs = new Map<string, string>();
  return { valeurs, lire: async (c) => valeurs.get(c) ?? null, ecrire: async (c, v) => { valeurs.set(c, v); } };
}

function appState(initial = 'active') {
  const ecouteurs = new Map<string, Set<(etat: string) => void>>();
  const a: AppStateRN & { emettre(type: string, etat: string): void } = {
    currentState: initial,
    addEventListener: (type, ecouteur) => {
      if (!ecouteurs.has(type)) ecouteurs.set(type, new Set());
      ecouteurs.get(type)!.add(ecouteur);
      return { remove: () => ecouteurs.get(type)?.delete(ecouteur) };
    },
    emettre(type, etat) { if (type === 'change') this.currentState = etat; for (const e of ecouteurs.get(type) ?? []) e(etat); }
  };
  return a;
}

const attendre = () => new Promise((r) => setImmediate(r));
const globaux = { console: { error: () => undefined, warn: () => undefined } };

test('mémoire d’un lancement à l’autre : app tuée au premier plan => session anormale et fermeture inattendue avec le fil d’Ariane et l’écran', async () => {
  const stockage = memoireVive();
  const premier = demarrer({ ...CONFIG, plateforme: 'ios', appState: appState(), stockage, globaux, blocages: false }, transportFactice().transport, { minuterie: false });
  await attendre();
  const sessionTuee = premier.sessionCourante();
  premier.ecran('Lecteur');
  premier.miette('clic', 'Direct lancé');
  // L'app est tuée ici (mémoire, plantage natif) : rien ne se ferme ; l'état a été gardé (au plus 1 s après).
  await new Promise((r) => setTimeout(r, 1100));
  const tr = transportFactice();
  const second = demarrer({ ...CONFIG, plateforme: 'ios', appState: appState(), stockage, globaux, blocages: false }, tr.transport, { minuterie: false });
  await attendre();
  await second.vider();
  const sessions = evenements(tr).filter((e) => e.type === 'session') as EvenementSession[];
  assert.ok(sessions.some((s) => s.id === sessionTuee && s.etat === 'anormal'));
  const fermeture = erreurs(tr).find((e) => e.exception.type === 'FermetureInattendue');
  assert.ok(fermeture);
  assert.equal(fermeture.niveau, 'fatal');
  assert.equal(fermeture.etiquettes?.ecran, 'Lecteur');
  assert.deepEqual(fermeture.filAriane?.map((m) => m.message).slice(-2), ['Lecteur', 'Direct lancé']);
  premier.debrancher(); second.debrancher();
});

test('mémoire : plantage JavaScript => session « plantage » sans fermeture inattendue ; tuée en arrière-plan => anormale seulement', async () => {
  const stockage = memoireVive();
  const errorUtils = { setGlobalHandler: () => undefined, getGlobalHandler: () => undefined };
  const a = demarrer({ ...CONFIG, plateforme: 'ios', appState: appState(), stockage, globaux, errorUtils, blocages: false }, transportFactice().transport, { minuterie: false });
  await attendre();
  const plantee = a.sessionCourante();
  // Le plantage ferme la session dans la file, mais l'app meurt avant l'envoi : l'état gardé dit « fatale ».
  stockage.valeurs.set('astratra-centrale:etat', JSON.stringify({ ...JSON.parse(stockage.valeurs.get('astratra-centrale:etat')!), fatale: true }));
  const tr = transportFactice();
  const b = demarrer({ ...CONFIG, plateforme: 'ios', appState: appState(), stockage, globaux, blocages: false }, tr.transport, { minuterie: false });
  await attendre();
  await b.vider();
  assert.ok((evenements(tr).filter((e) => e.type === 'session') as EvenementSession[]).some((s) => s.id === plantee && s.etat === 'plantage'));
  assert.ok(!erreurs(tr).some((e) => e.exception.type === 'FermetureInattendue'));

  // Arrière-plan puis tuée : seulement la session anormale (iOS ferme les apps en arrière-plan, c'est normal).
  const app = appState();
  const c = demarrer({ ...CONFIG, plateforme: 'ios', appState: app, stockage, globaux, blocages: false }, transportFactice().transport, { minuterie: false });
  await attendre();
  app.emettre('change', 'background');
  const tr2 = transportFactice();
  const d = demarrer({ ...CONFIG, plateforme: 'ios', appState: appState(), stockage, globaux, blocages: false }, tr2.transport, { minuterie: false });
  await attendre();
  await d.vider();
  assert.ok(!erreurs(tr2).some((e) => e.exception.type === 'FermetureInattendue'));
  for (const x of [a, b, c, d]) x.debrancher();
});

test('alerte mémoire d’iOS : dans le fil d’Ariane à chaque fois, signalée au plus une fois par minute', async () => {
  const app = appState();
  const h = horloge();
  const tr = transportFactice();
  const c = demarrer({ ...CONFIG, plateforme: 'ios', appState: app, globaux, blocages: false }, tr.transport, { minuterie: false, maintenant: h.maintenant });
  app.emettre('memoryWarning', '');
  app.emettre('memoryWarning', '');
  h.avancer(61_000);
  app.emettre('memoryWarning', '');
  await c.vider();
  assert.equal(erreurs(tr).filter((e) => e.exception.type === 'MemoireSaturee').length, 2);
  assert.equal(c.filAriane().filter((m) => m.message === 'Mémoire saturée').length, 3);
  c.debrancher();
});
