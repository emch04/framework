import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvenementIA } from '../src/envoi.ts';
import { creerCentrale, definirCentraleParDefaut } from '../src/coeur.ts';
import { estErreurQuota, mesurerAppelIA } from '../src/ia.ts';
import { CONFIG, transportFactice } from './aides.ts';

function preparer() {
  const t = transportFactice();
  const centrale = creerCentrale(CONFIG, t.transport, { minuterie: false });
  const ias = async () => { await centrale.vider(); return t.envois().flatMap((e) => e.evenements) as EvenementIA[]; };
  return { t, centrale, ias };
}

test('appel réussi : durée, jetons, résultat rendu tel quel, aucun contenu envoyé', async () => {
  const { t, centrale, ias } = preparer();
  const reponse = { texte: 'réponse confidentielle', usage: { input_tokens: 120, output_tokens: 40 } };
  const r = await mesurerAppelIA(
    { centrale, fournisseur: 'anthropic', modele: 'claude-haiku', outil: 'oracle', jetons: (x) => ({ entree: x.usage.input_tokens, sortie: x.usage.output_tokens }) },
    async () => { await new Promise((ok) => setTimeout(ok, 20)); return reponse; }
  );
  assert.equal(r, reponse);
  const [ev] = await ias();
  assert.equal(ev.type, 'ia');
  assert.equal(ev.resultat, 'ok');
  assert.equal(ev.fournisseur, 'anthropic');
  assert.equal(ev.outil, 'oracle');
  assert.equal(ev.jetonsEntree, 120);
  assert.equal(ev.jetonsSortie, 40);
  assert.ok(ev.dureeMs >= 15, `durée ${ev.dureeMs}`);
  assert.ok(!t.requetes[0].corps.includes('confidentielle'));
});

test('erreur : relancée chez l\'appelant, classée erreur ou quota', async () => {
  const { centrale, ias } = preparer();
  const panne = new Error('panne');
  await assert.rejects(mesurerAppelIA({ centrale, fournisseur: 'groq', modele: 'm' }, () => { throw panne; }), panne);
  await assert.rejects(mesurerAppelIA({ centrale, fournisseur: 'groq', modele: 'm' }, () => Promise.reject(Object.assign(new Error('x'), { status: 429 }))));
  await assert.rejects(mesurerAppelIA({ centrale, fournisseur: 'gemini', modele: 'm' }, () => Promise.reject(new Error('RESOURCE_EXHAUSTED: quota exceeded'))));
  assert.deepEqual((await ias()).map((e) => e.resultat), ['erreur', 'quota', 'quota']);
});

test('repli détecté ; lecteurs fautifs sans effet ; instance par défaut ; aucune instance', async () => {
  const { centrale, ias } = preparer();
  definirCentraleParDefaut(centrale);
  try {
    const r = await mesurerAppelIA(
      { fournisseur: 'mistral', modele: 'secours', estRepli: () => true, jetons: () => { throw new Error('lecteur cassé'); } },
      () => 7
    );
    assert.equal(r, 7);
    const [ev] = await ias();
    assert.equal(ev.resultat, 'repli');
    assert.equal(ev.jetonsEntree, undefined);
  } finally {
    definirCentraleParDefaut(undefined);
  }
  assert.equal(await mesurerAppelIA({ fournisseur: 'f', modele: 'm' }, () => 'sans instance'), 'sans instance');
});

test('estErreurQuota', () => {
  assert.equal(estErreurQuota({ statusCode: 429 }), true);
  assert.equal(estErreurQuota({ code: 'insufficient_quota' }), true);
  assert.equal(estErreurQuota(new Error('Rate limit reached')), true);
  assert.equal(estErreurQuota(new Error('timeout')), false);
  assert.equal(estErreurQuota('quota'), false);
  assert.equal(estErreurQuota(null), false);
});
