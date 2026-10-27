import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvenementErreur } from '../src/envoi.ts';
import { creerCentrale } from '../src/coeur.ts';
import type { ReglagesInternes } from '../src/coeur.ts';
import { CONFIG, transportFactice } from './aides.ts';

const SANS_MINUTERIE: ReglagesInternes = { minuterie: false };

function erreursEnvoyees(t: ReturnType<typeof transportFactice>): string[] {
  return t.envois().flatMap((e) => e.evenements).filter((e): e is EvenementErreur => e.type === 'erreur').map((e) => e.exception.message);
}

test('les bruits des extensions du navigateur ne partent pas, les vraies erreurs si', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  assert.equal(c.erreur(new Error('Invalid call to runtime.sendMessage(). Tab not found.')), undefined);
  c.erreur(new Error('Extension context invalidated.'));
  c.erreur('Could not establish connection. Receiving end does not exist.');
  const id = c.erreur(new Error('vraie erreur de l’application'));
  assert.equal(typeof id, 'string');
  await c.vider();
  assert.deepEqual(erreursEnvoyees(t), ['vraie erreur de l’application']);
});

test('une pile entièrement dans une extension ne part pas ; un seul cadre de l’app suffit à la garder', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  c.erreur(new Error('a'), { pile: [{ fichier: 'safari-web-extension://ABC/content.js', ligne: 1, app: false }, { fichier: 'chrome-extension://xyz/bg.js', app: false }] });
  c.erreur(new Error('b'), { pile: [{ fichier: 'chrome-extension://xyz/bg.js', app: false }, { fichier: 'https://site.fr/assets/app.js', app: true }] });
  await c.vider();
  assert.deepEqual(erreursEnvoyees(t), ['b']);
});

test('ignorer : textes et expressions propres à l’app ; bruitsExternes: false garde les bruits', async () => {
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, ignorer: ['ResizeObserver loop', /^Annulé par l’utilisateur$/, '', 42 as unknown as string], bruitsExternes: false }, t.transport, SANS_MINUTERIE);
  c.erreur(new Error('ResizeObserver loop completed with undelivered notifications.'));
  c.erreur(new Error('Annulé par l’utilisateur'));
  c.erreur(new Error('Annulé par l’utilisateur, puis plantage'));
  c.erreur(new Error('Invalid call to runtime.sendMessage(). Tab not found.'));
  await c.vider();
  assert.deepEqual(erreursEnvoyees(t), ['Annulé par l’utilisateur, puis plantage', 'Invalid call to runtime.sendMessage(). Tab not found.']);
});
