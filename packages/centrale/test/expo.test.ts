import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvenementErreur, EvenementSession, EvenementVue } from '../src/envoi.ts';
import { ARRIERE_PLAN_MS, demarrer } from '../src/expo.ts';
import type { AppStateRN, ErrorUtilsRN } from '../src/expo.ts';
import { CONFIG, horloge, transportFactice } from './aides.ts';

type Gestionnaire = (erreur: unknown, estFatale?: boolean) => void;

function fauxErrorUtils() {
  const appels: Array<[unknown, boolean | undefined]> = [];
  let courant: Gestionnaire = (e, f) => { appels.push([e, f]); };
  const errorUtils: ErrorUtilsRN = {
    setGlobalHandler: (g) => { courant = g; },
    getGlobalHandler: () => courant
  };
  return { errorUtils, appels, lancer: (e: unknown, fatale?: boolean) => courant(e, fatale) };
}

function fauxAppState(initial = 'active') {
  const ecouteurs = new Set<(etat: string) => void>();
  const appState: AppStateRN & { changer(etat: string): void; ecouteurs: number } = {
    currentState: initial,
    addEventListener: (type, ecouteur) => {
      // Seuls les changements d'état passent ici ; l'alerte mémoire a son propre test.
      if (type !== 'change') return { remove: () => undefined };
      ecouteurs.add(ecouteur);
      return { remove: () => ecouteurs.delete(ecouteur) };
    },
    changer(etat: string) { this.currentState = etat; for (const e of ecouteurs) e(etat); },
    get ecouteurs() { return ecouteurs.size; }
  };
  return appState;
}

const CONFIG_EXPO = { ...CONFIG, plateforme: 'ios' as const, version: '3.1.0', build: '42', miseAJour: 'maj-1', os: 'iOS 26.0', appareil: 'iPhone17,1' };

test('contexte injecté, écrans, erreurs non fatales, gestionnaire précédent rappelé', async () => {
  const eu = fauxErrorUtils();
  const t = transportFactice();
  const c = demarrer({ ...CONFIG_EXPO, errorUtils: eu.errorUtils }, t.transport, { minuterie: false });
  c.ecran('Accueil');
  c.ecran('Accueil'); // même écran : ignoré
  c.ecran('FicheEleve');
  const erreur = new Error('rendu impossible');
  eu.lancer(erreur, false);
  assert.deepEqual(eu.appels, [[erreur, false]]);
  await c.vider();
  c.debrancher();
  const envoi = t.envois()[0];
  assert.equal(envoi.sdk.nom, '@astratra/centrale/expo');
  assert.deepEqual(
    [envoi.contexte.plateforme, envoi.contexte.version, envoi.contexte.build, envoi.contexte.miseAJour, envoi.contexte.os, envoi.contexte.appareil],
    ['ios', '3.1.0', '42', 'maj-1', 'iOS 26.0', 'iPhone17,1']
  );
  const evs = t.envois().flatMap((e) => e.evenements);
  assert.deepEqual((evs.filter((e) => e.type === 'vue') as EvenementVue[]).map((v) => v.nom), ['Accueil', 'FicheEleve']);
  const err = evs.find((e) => e.type === 'erreur') as EvenementErreur;
  assert.equal(err.niveau, 'erreur');
  assert.deepEqual(err.filAriane?.map((m) => m.message), ["Lancement de l'app", 'Accueil', 'Accueil → FicheEleve']);
});

test('erreur fatale : plantage enregistré, vidage, puis gestionnaire précédent', async () => {
  const eu = fauxErrorUtils();
  const t = transportFactice();
  const c = demarrer({ ...CONFIG_EXPO, errorUtils: eu.errorUtils }, t.transport, { minuterie: false });
  const erreur = new Error('fatale');
  eu.lancer(erreur, true);
  assert.equal(eu.appels.length, 0, 'le gestionnaire précédent attend le vidage');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(eu.appels, [[erreur, true]]);
  const evs = t.envois().flatMap((e) => e.evenements);
  assert.equal((evs.find((e) => e.type === 'erreur') as EvenementErreur).niveau, 'fatal');
  assert.deepEqual((evs.filter((e) => e.type === 'session') as EvenementSession[]).map((s) => s.etat), ['debut', 'plantage']);
  c.debrancher();
});

test('erreur fatale avec un transport bloqué : le gestionnaire précédent est rappelé quand même', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const eu = fauxErrorUtils();
  const c = demarrer({ ...CONFIG_EXPO, errorUtils: eu.errorUtils }, () => new Promise(() => {}), { minuterie: false });
  eu.lancer(new Error('fatale'), true);
  assert.equal(eu.appels.length, 0);
  t.mock.timers.tick(2000);
  assert.equal(eu.appels.length, 1);
  c.debrancher();
});

test('sessions liées à AppState : 30 s d\'arrière-plan terminent la session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = horloge();
  const app = fauxAppState();
  const tr = transportFactice();
  const c = demarrer({ ...CONFIG_EXPO, appState: app, errorUtils: fauxErrorUtils().errorUtils }, tr.transport, { minuterie: false, maintenant: h.maintenant });
  const s1 = c.sessionCourante();
  assert.ok(s1);
  // Court passage en arrière-plan : même session.
  app.changer('background');
  h.avancer(10_000); t.mock.timers.tick(10_000);
  app.changer('active');
  assert.equal(c.sessionCourante(), s1);
  // Plus de 30 s : la minuterie termine la session ; au retour, une nouvelle commence.
  app.changer('background');
  h.avancer(ARRIERE_PLAN_MS); t.mock.timers.tick(ARRIERE_PLAN_MS);
  assert.equal(c.sessionCourante(), undefined);
  app.changer('active');
  const s2 = c.sessionCourante();
  assert.ok(s2 && s2 !== s1);
  // JavaScript suspendu (la minuterie n'a pas tourné) : la fin est constatée au retour.
  app.changer('background');
  h.avancer(ARRIERE_PLAN_MS + 5000);
  app.changer('active');
  const s3 = c.sessionCourante();
  assert.ok(s3 && s3 !== s2);
  c.debrancher();
  assert.equal(app.ecouteurs, 0);
  t.mock.timers.reset();
  await c.vider();
  const sessions = tr.envois().flatMap((e) => e.evenements).filter((e) => e.type === 'session') as EvenementSession[];
  assert.deepEqual(sessions.map((s) => s.etat), ['debut', 'ok', 'debut', 'ok', 'debut']);
});

test('plantage natif signalé au lancement suivant', async () => {
  const t = transportFactice();
  const c = demarrer({ ...CONFIG_EXPO, plateforme: 'android', errorUtils: fauxErrorUtils().errorUtils }, t.transport, { minuterie: false });
  c.signalerPlantageNatif({
    type: 'ANR', raison: 'REASON_ANR', horodatage: '2026-10-06T08:00:00.000Z',
    pile: [{ fichier: 'com/exemple/Main.java', fonction: 'onCreate', ligne: 10, app: true }]
  });
  c.signalerPlantageNatif(null as never);
  await c.vider();
  c.debrancher();
  const erreurs = t.envois().flatMap((e) => e.evenements).filter((e) => e.type === 'erreur') as EvenementErreur[];
  assert.equal(t.envois()[0].contexte.plateforme, 'android');
  assert.equal(erreurs[0].niveau, 'fatal');
  assert.equal(erreurs[0].horodatage, '2026-10-06T08:00:00.000Z');
  assert.equal(erreurs[0].exception.type, 'ANR');
  assert.equal(erreurs[0].exception.pile[0].fonction, 'onCreate');
  assert.deepEqual(erreurs[0].etiquettes, { source: 'natif', raison: 'REASON_ANR' });
});

test('mode strict : ni appareil ni utilisateur ; desactive : aucun gestionnaire posé', async () => {
  const t = transportFactice();
  const c = demarrer({ ...CONFIG_EXPO, strict: true, errorUtils: fauxErrorUtils().errorUtils }, t.transport, { minuterie: false });
  c.definirUtilisateur('eleve-1');
  c.ecran('Accueil');
  await c.vider();
  c.debrancher();
  assert.equal(t.envois()[0].contexte.appareil, undefined);
  assert.equal(t.envois()[0].contexte.utilisateur, undefined);

  const eu = fauxErrorUtils();
  const avant = eu.errorUtils.getGlobalHandler();
  const inactive = demarrer({ ...CONFIG_EXPO, desactive: true, errorUtils: eu.errorUtils });
  assert.equal(eu.errorUtils.getGlobalHandler(), avant);
  assert.doesNotThrow(() => { inactive.ecran('x'); inactive.signalerPlantageNatif({ type: 'x' }); });
});
