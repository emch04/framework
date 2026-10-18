import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lirePasserelle, modeleDiscussion, passerelleDabord, PasserelleIndisponible, plongements, rechercher, RequetePasserelleRefusee, voix } from '../src/passerelle.ts';

/* Le client de la passerelle des clés : jeton lu dans l'environnement, appels authentifiés, repli sur les clés directes. */
const JETON = 'clj_pas_' + 'a'.repeat(40);

function fauxFetch(reponses: Array<(url: string, init: RequestInit) => Response | Promise<Response>>) {
  const appels: Array<{ url: string; init: RequestInit; corps: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    appels.push({ url, init, corps: init.body ? JSON.parse(String(init.body)) : null });
    const r = reponses.shift();
    if (!r) throw new Error('aucune réponse prévue');
    return r(url, init);
  }) as unknown as typeof fetch;
  return { f, appels };
}
const json = (statut: number, corps: unknown, entetes: Record<string, string> = {}) => new Response(JSON.stringify(corps), { status: statut, headers: { 'Content-Type': 'application/json', ...entetes } });

test('lirePasserelle : jeton bien formé et adresse HTTPS, sinon rien de branché', () => {
  const f = (async () => json(200, {})) as unknown as typeof fetch;
  const p = lirePasserelle({ CENTRALE_ADRESSE: 'https://centrale.exemple.fr/', CENTRALE_PASSERELLE_JETON: ` ${JETON} ` }, { fetch: f });
  assert.equal(p?.adresse, 'https://centrale.exemple.fr');
  assert.equal(p?.jeton, JETON);
  assert.equal(lirePasserelle({ CENTRALE_ADRESSE: 'https://c.fr', CENTRALE_PASSERELLE_JETON: 'clj_pub_xx' }, { fetch: f }), null, 'pas un jeton de passerelle');
  assert.equal(lirePasserelle({ CENTRALE_ADRESSE: 'http://c.fr', CENTRALE_PASSERELLE_JETON: JETON }, { fetch: f }), null, 'HTTP hors boucle locale');
  assert.ok(lirePasserelle({ CENTRALE_ADRESSE: 'http://127.0.0.1:4000', CENTRALE_PASSERELLE_JETON: JETON }, { fetch: f }), 'boucle locale permise');
  assert.equal(lirePasserelle({ CENTRALE_PASSERELLE_JETON: JETON }, { fetch: f }), null, 'sans adresse');
  const m = modeleDiscussion(p!);
  assert.deepEqual(m, { url: 'https://centrale.exemple.fr/v1/passerelle/ia/chat/completions', baseUrl: 'https://centrale.exemple.fr/v1/passerelle/ia', apiKey: JETON, model: 'auto', thoughtSignatures: true });
});

test('plongements, recherche et voix : jeton porteur, formats lus', async () => {
  const { f, appels } = fauxFetch([
    () => json(200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }),
    () => json(200, { fournisseur: 'serper', periode: 'an', encadre: { reponse: 'R', titre: 'A', url: null }, fiche: { titre: 'F', description: 'D', site: null },
      resultats: [{ position: 1, titre: 'T', url: 'https://x.fr', extrait: 'E', date: '2 sept. 2026', liens: ['L'] }] }),
    () => new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { 'Content-Type': 'audio/wav', 'X-Audio-Rate': '24000', 'X-Audio-Channels': '1' } })
  ]);
  const p = lirePasserelle({ CENTRALE_ADRESSE: 'https://c.fr', CENTRALE_PASSERELLE_JETON: JETON }, { fetch: f })!;
  assert.deepEqual(await plongements(p, ['a', 'b'], { dimensions: 768 }), [[1, 0], [0, 1]], 'remis dans l’ordre des textes');
  const r = await rechercher(p, { requete: 'météo Paris', nombre: 3, langue: 'fr', periode: 'an' });
  assert.equal(r.resultats[0].url, 'https://x.fr');
  assert.deepEqual([r.resultats[0].date, r.resultats[0].liens, r.encadre?.reponse, r.fiche?.description, r.periode], ['2 sept. 2026', ['L'], 'R', 'D', 'an']);
  const v = await voix(p, { texte: 'Bonjour', langue: 'fr' });
  assert.deepEqual([v.audio.length, v.type, v.frequence, v.canaux], [4, 'audio/wav', 24000, 1]);
  assert.deepEqual(appels.map((a) => a.url), ['https://c.fr/v1/passerelle/ia/embeddings', 'https://c.fr/v1/passerelle/recherche', 'https://c.fr/v1/passerelle/voix']);
  assert.ok(appels.every((a) => (a.init.headers as Record<string, string>).Authorization === `Bearer ${JETON}`));
  assert.deepEqual(appels[0].corps, { model: 'auto', input: ['a', 'b'], dimensions: 768 });
  assert.deepEqual(appels[1].corps, { requete: 'météo Paris', nombre: 3, langue: 'fr', periode: 'an' });
});

test('pannes : 5xx, 429, 503, jeton refusé et réseau coupé => indisponible ; 400 et 413 => refusée', async () => {
  for (const statut of [500, 502, 503, 429, 401, 403]) {
    const { f } = fauxFetch([() => json(statut, { error: { code: 'x' } })]);
    const p = lirePasserelle({ CENTRALE_ADRESSE: 'https://c.fr', CENTRALE_PASSERELLE_JETON: JETON }, { fetch: f })!;
    await assert.rejects(rechercher(p, { requete: 'a' }), (e) => e instanceof PasserelleIndisponible && e.statut === statut);
  }
  const { f: coupe } = fauxFetch([() => { throw new TypeError('fetch failed'); }]);
  await assert.rejects(rechercher(lirePasserelle({ CENTRALE_ADRESSE: 'https://c.fr', CENTRALE_PASSERELLE_JETON: JETON }, { fetch: coupe })!, { requete: 'a' }), PasserelleIndisponible);
  const { f: refus } = fauxFetch([() => json(413, { error: { code: 'trop_grand' } })]);
  await assert.rejects(voix(lirePasserelle({ CENTRALE_ADRESSE: 'https://c.fr', CENTRALE_PASSERELLE_JETON: JETON }, { fetch: refus })!, { texte: 'x' }), RequetePasserelleRefusee);
});

test('passerelleDabord : la passerelle, puis les clés directes seulement en cas de panne', async () => {
  const replis: number[] = [];
  assert.equal(await passerelleDabord(null, async () => 'passerelle', async () => 'direct'), 'direct', 'non réglée');
  const p = lirePasserelle({ CENTRALE_ADRESSE: 'https://c.fr', CENTRALE_PASSERELLE_JETON: JETON }, { fetch: (async () => json(200, {})) as unknown as typeof fetch })!;
  assert.equal(await passerelleDabord(p, async () => 'passerelle', async () => 'direct'), 'passerelle');
  assert.equal(await passerelleDabord(p, async () => { throw new PasserelleIndisponible(502, 'x'); }, async () => 'direct', (e) => replis.push(e.statut ?? 0)), 'direct');
  assert.deepEqual(replis, [502]);
  await assert.rejects(passerelleDabord(p, async () => { throw new RequetePasserelleRefusee(400, 'x'); }, async () => 'direct'), RequetePasserelleRefusee, 'un refus ne passe pas aux clés directes');
});
