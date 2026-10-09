import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerConscienceCentrale, resumerBilan, nettoyerMesures, ErreurConscience, type RapportGouverneur } from '../src/conscience.ts';

/** Un faux tableau de bord : garde les requêtes et rend les réponses prévues dans l'ordre. */
function fauxFetch(reponses: Array<Response | (() => Response) | Error>) {
  const requetes: Array<{ url: string; methode: string; entetes: Record<string, string>; corps: unknown }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    requetes.push({ url, methode: String(init.method), entetes: init.headers as Record<string, string>, corps: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = reponses.shift();
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r ?? new Response(null, { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { f, requetes };
}
const json = (corps: unknown, statut = 200, entetes: Record<string, string> = {}) =>
  new Response(JSON.stringify(corps), { status: statut, headers: { 'Content-Type': 'application/json', ...entetes } });
const REGLAGES = { schema: 'conscience-settings/1', version: 3, enabled: true, halted: false, haltedAt: null, resumedBy: null, approvers: ['compte-1'],
  reflection: { automatic: true, hour: 4, timeZone: 'Europe/Paris' }, cyclesPerDay: 2, updatedAt: '2026-10-09T08:00:00.000Z' };

test('réglages : jeton porteur, cache par ETag (304 rend la copie), erreurs au format du tableau de bord', async () => {
  const { f, requetes } = fauxFetch([
    json(REGLAGES, 200, { ETag: '"conscience-3"' }),
    new Response(null, { status: 304 }),
    json({ error: { code: 'invalid_api_key', message: 'Jeton révoqué.' } }, 401),
    new TypeError('fetch failed')
  ]);
  const c = creerConscienceCentrale({ adresse: 'https://tableau.exemple.fr/', jeton: 'jeton-projet', fetch: f });
  assert.deepEqual(await c.lireReglages(), REGLAGES);
  assert.equal(requetes[0].url, 'https://tableau.exemple.fr/v1/conscience/settings');
  assert.equal(requetes[0].entetes.Authorization, 'Bearer jeton-projet');
  assert.equal(requetes[0].entetes['If-None-Match'], undefined);
  assert.deepEqual(await c.lireReglages(), REGLAGES);
  assert.equal(requetes[1].entetes['If-None-Match'], '"conscience-3"');
  await assert.rejects(c.lireReglages(), (e: unknown) => e instanceof ErreurConscience && e.statut === 401 && e.code === 'invalid_api_key' && e.message === 'Jeton révoqué.');
  await assert.rejects(c.lireReglages(), (e: unknown) => e instanceof ErreurConscience && e.statut === null && e.code === 'reseau');
  assert.throws(() => creerConscienceCentrale({ adresse: 'tableau', jeton: 'x' }), (e: unknown) => (e as ErreurConscience).code === 'adresse_invalide');
  assert.throws(() => creerConscienceCentrale({ adresse: 'https://t', jeton: ' ' }), (e: unknown) => (e as ErreurConscience).code === 'jeton_absent');
});

const RAPPORT: RapportGouverneur = {
  since: '2026-10-08T04:00:00.000Z', until: new Date('2026-10-09T04:00:00.000Z'), policyVersion: 'app-2026-10', halted: false,
  counts: { findings: 2, pending: 2, pendingHighRisk: 0, approvedAwaitingStage: 0, rollouts: 0, rejections: 0, humanRejections: 0, rollbacks: 0, secret: 'x' as never },
  findings: { items: [
    { code: 'answer_feedback', severity: 'info', subject: { kind: 'agent', id: 'assistant' }, sampleSize: 40,
      metrics: { succeeded: 30, rate: 0.75, status: 'observed', interval: { low: 0.6, high: 0.86 }, note: 'La personne a dit merci', email: 'alice@example.com' } },
    { code: 'Question de Bruno sur sa facture', severity: 'info', subject: { kind: 'agent', id: 'assistant' } }
  ] },
  pendingProposals: [
    { id: 'proposal_' + 'ab'.repeat(16), target: { kind: 'instructions', id: 'answer_style' }, risk: 'medium', requiredApprovals: 1, approvalsValid: 0, scopes: ['style'],
      proposedBy: { kind: 'engine', id: 'reflection' }, createdAt: '2026-10-09T04:00:00.000Z', hasTests: true, hasRollbackPlan: true },
    { id: 'p_humain', target: { kind: 'threshold', id: 'confidence' }, risk: 'high', requiredApprovals: 2, approvalsValid: 1, scopes: [],
      proposedBy: { kind: 'human', id: 'alice@example.com' }, createdAt: '2026-10-09T04:00:00.000Z', hasTests: false, hasRollbackPlan: false }
  ]
};

test('bilan : réduit à des codes et des nombres ; aucune phrase, adresse ni identité de personne ne part', async () => {
  const b = resumerBilan(RAPPORT, [
    { id: 'proposal_' + 'ab'.repeat(16), change: { hint: 'shorter_answers', prompt: 'Réponds toujours en trois lignes' }, justification: 'correction_style' },
    { id: 'p_humain', change: { min: 0.6 }, justification: 'Parce que Bruno trouvait les réponses trop longues' }
  ]);
  assert.equal(b.schema, 'conscience-report/1');
  assert.equal(b.until, '2026-10-09T04:00:00.000Z');
  assert.deepEqual(Object.keys(b.counts).sort(), ['approvedAwaitingStage', 'findings', 'humanRejections', 'pending', 'pendingHighRisk', 'rejections', 'rollbacks', 'rollouts']);
  assert.equal(b.findings.length, 1, 'le constat dont le code est une phrase est retiré');
  assert.deepEqual(b.findings[0].metrics, { succeeded: 30, rate: 0.75, status: 'observed', interval: { low: 0.6, high: 0.86 } });
  assert.deepEqual(b.pending[0].change, { hint: 'shorter_answers' });
  assert.equal(b.pending[0].justification, 'correction_style');
  assert.equal(b.pending[1].justification, null);
  assert.deepEqual(b.pending[1].proposedBy, { kind: 'human', id: null });
  const texte = JSON.stringify(b);
  for (const interdit of ['@', 'Bruno', 'merci', 'trois lignes', 'secret']) assert.ok(!texte.includes(interdit), interdit);
  assert.deepEqual(nettoyerMesures({ a: [1, 2], b: ['x'], c: { d: { e: 1 } }, 'clé libre': 1, f: Infinity }), { a: [1, 2], c: {} });
});

test('envoi du bilan, puis décisions : non accusées reprises au passage suivant ; accusés sauf « failed »', async () => {
  const decisions = [
    { id: 'd-1', sequence: 7, proposalId: 'p1', decision: 'approve', approver: { kind: 'human', id: 'compte-1' }, reasonCode: null, decidedAt: '2026-10-09T09:00:00Z', acknowledged: false },
    { id: 'd-2', sequence: 8, proposalId: 'p2', decision: 'decline', approver: { kind: 'human', id: 'compte-1' }, reasonCode: 'risk_too_high', decidedAt: '2026-10-09T09:01:00Z', acknowledged: false }
  ];
  const { f, requetes } = fauxFetch([
    json({ received: { findings: 1, pending: 2 } }, 202),
    json({ decisions, next: 8 }),
    json({ ok: true }), json({ ok: true }),
    json({ decisions: [], next: 0 }),
    json({ decisions, next: 8 }),
    json({ decisions: [], next: 8 })
  ]);
  const c = creerConscienceCentrale({ adresse: 'https://tableau.exemple.fr', jeton: 'j', fetch: f });
  assert.deepEqual(await c.envoyerBilan(RAPPORT), { received: { findings: 1, pending: 2 } });
  assert.equal(requetes[0].methode, 'POST');
  assert.equal(requetes[0].url, 'https://tableau.exemple.fr/v1/conscience/report');
  assert.equal(requetes[0].entetes['Content-Type'], 'application/json');
  assert.ok(!JSON.stringify(requetes[0].corps).includes('alice@example.com'));

  const lues = await c.lireDecisions();
  assert.equal(lues.length, 2);
  assert.equal(requetes[1].url, 'https://tableau.exemple.fr/v1/conscience/decisions');
  const n = await c.accuserDecisions([
    { id: 'd-1', result: 'applied', code: null },
    { id: 'd-2', result: 'refused', code: 'not_pending' },
    { id: 'd-3', result: 'failed', code: 'governor_unavailable' }
  ]);
  assert.equal(n, 2);
  assert.equal(requetes[2].url, 'https://tableau.exemple.fr/v1/conscience/decisions/d-1/ack');
  assert.deepEqual(requetes[3].corps, { result: 'refused', code: 'not_pending' });
  assert.equal(requetes.length, 4, 'la décision en échec n’est pas accusée');
  await c.lireDecisions();
  assert.equal(requetes[4].url, 'https://tableau.exemple.fr/v1/conscience/decisions', 'sans curseur : ce qui n’est pas accusé revient');
  await c.lireDecisions({ toutes: true });
  assert.equal(requetes[5].url, 'https://tableau.exemple.fr/v1/conscience/decisions?after=0&include=all');
  await c.lireDecisions({ toutes: true });
  assert.equal(requetes[6].url, 'https://tableau.exemple.fr/v1/conscience/decisions?after=8&include=all');
});

test('le paquet reste autonome : aucun import d’un autre paquet Astratra', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/conscience.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]@astratra\//);
  const paquet = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(paquet.dependencies ?? {}), []);
});
