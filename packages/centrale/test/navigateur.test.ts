import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Envoi, EvenementErreur, EvenementSession, EvenementVue } from '../src/envoi.ts';
import { demarrer, systemeDepuisAgent } from '../src/navigateur.ts';
import type { EnvironnementNavigateur } from '../src/navigateur.ts';
import { CONFIG, transportFactice } from './aides.ts';

/** Un faux navigateur : fenêtre et document en EventTarget, historique qui change l'adresse. */
function fauxNavigateur(options: { pret?: boolean; balise?: boolean; enLigne?: boolean } = {}) {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState, readyState: (options.pret === false ? 'loading' : 'complete') as DocumentReadyState });
  const location = { pathname: '/eleves/123' };
  const balises: Array<{ url: string; corps: string }> = [];
  const navigator = {
    onLine: options.enLigne ?? true,
    language: 'fr-FR',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
    sendBeacon: options.balise === false ? undefined : (url: string, corps?: unknown) => { balises.push({ url, corps: String(corps) }); return true; }
  };
  const history = {
    pushState(_etat: unknown, _titre: string, url?: string | URL | null) { if (url) location.pathname = String(url).split('?')[0]; },
    replaceState(_etat: unknown, _titre: string, url?: string | URL | null) { if (url) location.pathname = String(url).split('?')[0]; }
  };
  const performance = { getEntriesByType: (type: string) => type === 'navigation' ? [{ loadEventEnd: 812.4 }] : [] };
  const env = { window, document, location, history, navigator, performance } as unknown as EnvironnementNavigateur;
  const cacher = () => { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
  const montrer = () => { document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); };
  return { env, window, document, location, history, navigator, balises, cacher, montrer };
}

const evenementsBalises = (balises: Array<{ corps: string }>) => balises.flatMap((b) => (JSON.parse(b.corps) as Envoi).evenements);

test('erreurs, rejets, vues SPA en gabarit, session et balise finale', async () => {
  const n = fauxNavigateur();
  const t = transportFactice();
  const c = demarrer(CONFIG, t.transport, n.env, { minuterie: false });
  try {
    const e = new Error('clic raté');
    e.stack = 'surClic@https://app.exemple.fr/assets/index.js?v=2:1:2\n@https://app.exemple.fr/node_modules/react/index.js:3:4';
    n.window.dispatchEvent(Object.assign(new Event('error'), { error: e }));
    n.window.dispatchEvent(Object.assign(new Event('error'), { error: null, message: 'Script error.' }));
    n.window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new TypeError('promesse') }));
    n.env.history.pushState({}, '', '/eleves/456/notes?token=secret');
    n.env.history.pushState({}, '', '/eleves/789/notes'); // même gabarit : pas de nouvelle vue
    n.env.history.replaceState({}, '', '/classes');
    n.location.pathname = '/accueil';
    n.window.dispatchEvent(new Event('popstate'));
    n.cacher();
  } finally {
    c.debrancher();
  }
  assert.equal(t.requetes.length, 0, 'tout part par la balise');
  assert.ok(n.balises.length >= 1);
  assert.equal(n.balises[0].url, `https://centrale.exemple.fr/v1/envoi?cle=${CONFIG.cle}`);
  const envoi = JSON.parse(n.balises[0].corps) as Envoi;
  assert.equal(envoi.sdk.nom, '@astratra/centrale/navigateur');
  assert.equal(envoi.contexte.plateforme, 'web');
  assert.equal(envoi.contexte.os, 'macOS');
  assert.equal(envoi.contexte.langue, 'fr-FR');
  assert.ok(envoi.contexte.sessionId);

  const evs = evenementsBalises(n.balises);
  const vues = evs.filter((e) => e.type === 'vue') as EvenementVue[];
  assert.deepEqual(vues.map((v) => v.nom), ['/eleves/:id', '/eleves/:id/notes', '/classes', '/accueil']);
  assert.equal(vues[0].dureeChargementMs, 812);
  const erreurs = evs.filter((e) => e.type === 'erreur') as EvenementErreur[];
  assert.equal(erreurs.length, 3);
  assert.deepEqual(erreurs[0].exception.pile.map((p) => [p.fichier, p.app]), [
    ['https://app.exemple.fr/assets/index.js', true],
    ['https://app.exemple.fr/node_modules/react/index.js', false]
  ]);
  assert.equal(erreurs[1].exception.message, 'Script error.');
  assert.equal(erreurs[2].exception.type, 'TypeError');
  assert.equal(erreurs[2].etiquettes?.origine, 'unhandledrejection');
  const sessions = evs.filter((e) => e.type === 'session') as EvenementSession[];
  // Des erreurs ont eu lieu : la session se termine en « erreur ».
  assert.deepEqual(sessions.map((s) => s.etat), ['debut', 'erreur']);
  assert.ok(!n.balises.some((b) => b.corps.includes('secret')));
});

test('pushState d\'origine toujours appelé, et rétabli au débranchement', () => {
  const n = fauxNavigateur();
  const originale = n.env.history.pushState;
  const c = demarrer(CONFIG, transportFactice().transport, n.env, { minuterie: false });
  assert.notEqual(n.env.history.pushState, originale);
  n.env.history.pushState({}, '', '/autre');
  assert.equal(n.location.pathname, '/autre');
  c.debrancher();
  assert.equal(n.env.history.pushState, originale);
});

test('retour au premier plan : nouvelle session ; page pas encore chargée : vue au load', async () => {
  const n = fauxNavigateur({ pret: false });
  const c = demarrer(CONFIG, transportFactice().transport, n.env, { minuterie: false });
  const premiere = c.sessionCourante();
  n.cacher();
  assert.equal(c.sessionCourante(), undefined);
  n.montrer();
  assert.ok(c.sessionCourante());
  assert.notEqual(c.sessionCourante(), premiere);
  n.window.dispatchEvent(new Event('load'));
  await new Promise((r) => setTimeout(r, 5));
  n.cacher();
  c.debrancher();
  const vues = evenementsBalises(n.balises).filter((e) => e.type === 'vue') as EvenementVue[];
  assert.deepEqual(vues.map((v) => [v.nom, v.dureeChargementMs]), [['/eleves/:id', 812]]);
});

test('sans sendBeacon : vidage par le transport ; hors ligne : la file attend', async () => {
  const n = fauxNavigateur({ balise: false, enLigne: false });
  const t = transportFactice();
  const c = demarrer(CONFIG, t.transport, n.env, { minuterie: false });
  n.cacher();
  await c.vider();
  assert.equal(t.requetes.length, 0);
  assert.ok(c.enAttente() > 0);
  n.navigator.onLine = true;
  n.window.dispatchEvent(new Event('online'));
  await c.vider();
  assert.equal(t.requetes.length, 1);
  c.debrancher();
});

test('gabarit personnalisé, sessions coupées, desactive, pas d\'environnement', async () => {
  const n = fauxNavigateur();
  const c = demarrer({ ...CONFIG, sessions: false, gabarit: (chemin) => chemin.startsWith('/eleves') ? 'fiche-eleve' : chemin }, transportFactice().transport, n.env, { minuterie: false });
  n.cacher();
  c.debrancher();
  const evs = evenementsBalises(n.balises);
  assert.deepEqual(evs.map((e) => e.type), ['vue']);
  assert.equal((evs[0] as EvenementVue).nom, 'fiche-eleve');

  const n2 = fauxNavigateur();
  const inactive = demarrer({ ...CONFIG, desactive: true }, transportFactice().transport, n2.env);
  n2.window.dispatchEvent(Object.assign(new Event('error'), { error: new Error('x') }));
  n2.cacher();
  assert.equal(n2.balises.length, 0);
  inactive.debrancher();

  // Hors navigateur (Node) : instance utilisable, rien n'est branché, aucune exception.
  const sansEnv = demarrer(CONFIG, transportFactice().transport, undefined, { minuterie: false });
  assert.doesNotThrow(() => sansEnv.erreur(new Error('x')));
  sansEnv.debrancher();
});

test('systemeDepuisAgent', () => {
  assert.equal(systemeDepuisAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iOS');
  assert.equal(systemeDepuisAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'Android');
  assert.equal(systemeDepuisAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows');
  assert.equal(systemeDepuisAgent('Mozilla/5.0 (X11; Linux x86_64)'), 'Linux');
  assert.equal(systemeDepuisAgent(undefined), undefined);
});

test('un navigateur piloté par un robot (Playwright) ne collecte rien, sauf demande expresse', () => {
  const env = fauxNavigateur();
  const robotise = { ...env.env, navigator: { ...env.env.navigator, webdriver: true } } as EnvironnementNavigateur;
  const { transport } = transportFactice();
  const muet = demarrer({ ...CONFIG }, transport, robotise);
  assert.equal(muet.actif, false);
  muet.debrancher();
  const voulu = demarrer({ ...CONFIG, robots: true }, transport, robotise);
  assert.equal(voulu.actif, true);
  voulu.debrancher();
});
