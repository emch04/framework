import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerGouvernanceCentrale, ErreurGouvernance, etatDe, type VueProposition } from '../src/gouvernance.ts';

/** Un faux tableau de bord : garde les requêtes et rend les réponses prévues dans l'ordre. */
function fauxFetch(reponses: Array<Response | Error>) {
  const requetes: Array<{ url: string; methode: string; entetes: Record<string, string>; corps: any }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    requetes.push({ url, methode: String(init.method), entetes: init.headers as Record<string, string>, corps: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = reponses.shift();
    if (r instanceof Error) throw r;
    return r ?? new Response(null, { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { f, requetes };
}
const json = (corps: unknown, statut = 200, entetes: Record<string, string> = {}) =>
  new Response(JSON.stringify(corps), { status: statut, headers: { 'Content-Type': 'application/json', ...entetes } });
const REGLES = { schema: 'gouvernance-regles/1', version: 4, rules: [{ id: 'r', level: 'validation', match: {} }], updatedAt: null };
const vue = (extra: Partial<VueProposition> = {}): VueProposition => ({ status: 'awaiting_validation', code: null, proposal: { id: 'prop-1', digest: 'abc' }, explanation: 'Pourquoi', result: null, ...extra });

test('règles : jeton porteur, cache par ETag, erreurs au format du tableau de bord', async () => {
  const { f, requetes } = fauxFetch([
    json(REGLES, 200, { ETag: '"gouvernance-4"' }),
    new Response(null, { status: 304 }),
    json({ error: { code: 'invalid_api_key', message: 'Jeton révoqué.' } }, 401),
    new TypeError('fetch failed')
  ]);
  const g = creerGouvernanceCentrale({ adresse: 'https://tableau.exemple.fr/', jeton: 'jeton-projet', fetch: f });
  assert.deepEqual(await g.lireRegles(), { version: 4, rules: REGLES.rules });
  assert.equal(requetes[0].url, 'https://tableau.exemple.fr/v1/gouvernance/rules');
  assert.equal(requetes[0].entetes.Authorization, 'Bearer jeton-projet');
  assert.deepEqual(await g.lireRegles(), { version: 4, rules: REGLES.rules });
  assert.equal(requetes[1].entetes['If-None-Match'], '"gouvernance-4"');
  await assert.rejects(g.lireRegles(), (e: unknown) => e instanceof ErreurGouvernance && e.statut === 401 && e.code === 'invalid_api_key');
  await assert.rejects(g.lireRegles(), (e: unknown) => e instanceof ErreurGouvernance && e.statut === null && e.code === 'reseau');
  assert.throws(() => creerGouvernanceCentrale({ adresse: 'tableau', jeton: 'x' }), (e: unknown) => (e as ErreurGouvernance).code === 'adresse_invalide');
});

test('proposition : forme canonique et état envoyés, explication tronquée, rien sans empreinte', async () => {
  const { f, requetes } = fauxFetch([json({ id: 'prop-1', state: 'en_attente' }, 201)]);
  const g = creerGouvernanceCentrale({ adresse: 'https://t.exemple.fr', jeton: 'j', fetch: f });
  assert.deepEqual(await g.envoyerProposition(vue({ explanation: 'x'.repeat(5000) })), { id: 'prop-1', state: 'en_attente' });
  assert.equal(requetes[0].url, 'https://t.exemple.fr/v1/gouvernance/proposals');
  assert.equal(requetes[0].corps.status, 'awaiting_validation');
  assert.equal(requetes[0].corps.explanation.length, 4000);
  assert.deepEqual(requetes[0].corps.proposal, { id: 'prop-1', digest: 'abc' });
  await assert.rejects(g.envoyerProposition(vue({ proposal: null })), (e: unknown) => (e as ErreurGouvernance).code === 'proposition_absente');
  await assert.rejects(g.envoyerProposition(vue({ proposal: { id: '../x', digest: 'abc' } })), (e: unknown) => (e as ErreurGouvernance).code === 'identifiant_invalide');
  await assert.rejects(g.envoyerProposition(vue({ status: 'inventé' })), (e: unknown) => (e as ErreurGouvernance).code === 'etat_invalide');
});

test('état : seulement un état connu, un code court et un nombre de lignes', () => {
  assert.deepEqual(etatDe({ status: 'executed', code: 'Phrase libre', result: { rowsAffected: 3 } }), { status: 'executed', code: null, rowsAffected: 3 });
  assert.deepEqual(etatDe({ status: 'stale', code: 'stale_data', result: { rowsAffected: -2 } }), { status: 'stale', code: 'stale_data', rowsAffected: 0 });
  assert.deepEqual(etatDe({ status: null, code: 'not_found' }, { sansEtat: true }), { status: null, code: 'not_found', rowsAffected: 0 });
  assert.throws(() => etatDe({ status: null, code: 'not_found' }));
});

test('synchroniser : applique chaque validation, accuse le résultat, laisse revenir une panne', async () => {
  const validations = [
    { id: 'v1', sequence: 1, propositionId: 'prop-1', decision: 'approve', validation: { propositionId: 'prop-1' }, acknowledged: false },
    { id: 'v2', sequence: 2, propositionId: 'prop-2', decision: 'approve', validation: { propositionId: 'prop-2' }, acknowledged: false },
    { id: 'v3', sequence: 3, propositionId: 'prop-3', decision: 'approve', validation: { propositionId: 'prop-3' }, acknowledged: false }
  ];
  const { f, requetes } = fauxFetch([json({ validations, next: 3 }), json({ ok: true }), json({ ok: true })]);
  const g = creerGouvernanceCentrale({ adresse: 'https://t.exemple.fr', jeton: 'j', fetch: f });
  const vues: Record<string, VueProposition | Error> = {
    'prop-1': { status: 'executed', code: null, result: { rowsAffected: 2 } },
    'prop-2': new Error('base injoignable'),
    'prop-3': { status: null, code: 'not_found' }
  };
  const faits = await g.synchroniser({
    applyValidation: async (v, { organisationId }) => {
      assert.equal(organisationId, 'org-1');
      const r = vues[String(v.propositionId)];
      if (r instanceof Error) throw r;
      return r;
    }
  }, { organisationId: 'org-1' });
  assert.deepEqual(faits, [{ id: 'v1', status: 'executed', code: null }, { id: 'v2', status: null, code: 'apply_failed' }, { id: 'v3', status: null, code: 'not_found' }]);
  assert.deepEqual(requetes.map((r) => `${r.methode} ${r.url.replace('https://t.exemple.fr', '')}`), [
    'GET /v1/gouvernance/validations', 'POST /v1/gouvernance/validations/v1/ack', 'POST /v1/gouvernance/validations/v3/ack'
  ]);
  assert.deepEqual(requetes[1].corps, { status: 'executed', code: null, rowsAffected: 2 });
});

test('confiance : la forme attendue, sinon une erreur', async () => {
  const confiance = { schema: 'gouvernance-confiance/1', keys: [{ keyId: 'k', publicKey: 'MCow' }], approvers: [], rpId: 't.exemple.fr', origins: ['https://t.exemple.fr'] };
  const { f } = fauxFetch([json(confiance), json({ schema: 'autre' })]);
  const g = creerGouvernanceCentrale({ adresse: 'https://t.exemple.fr', jeton: 'j', fetch: f });
  assert.deepEqual(await g.lireConfiance(), confiance);
  await assert.rejects(g.lireConfiance(), (e: unknown) => (e as ErreurGouvernance).code === 'reponse_illisible');
});
