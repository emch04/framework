import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construireExecution, creerJournalAgents, dateJournal, validerExecution } from '../src/agents.ts';
import type { BilanAgent, ExecutionAgent } from '../src/agents.ts';
import { transportFactice, horloge } from './aides.ts';

const bilan: BilanAgent = {
  identifiant: 'run-1', agent: 'Elsa', mode: 'discussion', utilisateur: 'compte-42',
  debut: new Date('2026-10-16T10:00:00.789Z'), fin: new Date('2026-10-16T10:00:03.100Z'), statut: 'ok',
  tours: [
    { modele: 'm-a', dureeMs: 900, jetonsEntree: 100, jetonsSortie: 20, cout: 0.001 },
    { modele: 'm-b', dureeMs: 500, jetonsEntree: 50, jetonsSortie: 5, cout: 0.0005 }
  ],
  outils: [{ outil: 'lire_stock', succes: true, dureeMs: 12, arguments: { sku: 'jean@client.fr' }, resultat: 'secret ligne' }],
  actions: [{ outil: 'rembourser', etat: 'proposee' }],
  question: 'Où est ma commande ? jean@client.fr', reponse: 'Elle arrive.'
};

function exec(): ExecutionAgent { return construireExecution(bilan); }

test('construireExecution : sans contenu par défaut', () => {
  const e = exec();
  const texte = JSON.stringify(e);
  assert.equal(e.question, undefined);
  assert.equal(e.reponse, undefined);
  assert.ok(!texte.includes('jean@'));
  assert.ok(!texte.includes('secret ligne'));
  assert.equal(e.tours, 2);
  assert.deepEqual(e.modeles, ['m-a', 'm-b']);
  assert.equal(e.jetonsEntree, 150);
  assert.equal(e.jetonsSortie, 25);
  assert.equal(e.coutEstime, 0.0015);
  assert.equal(e.debut, '2026-10-16T10:00:00Z');
  assert.equal(e.fin, '2026-10-16T10:00:03Z');
  assert.equal(e.dureeMs, 3000);
  assert.equal(e.utilisateur, 'compte-42');
  assert.deepEqual(e.etapes.map((x) => x.type), ['tour_modele', 'tour_modele', 'appel_outil']);
  assert.equal(e.etapes[2].outil, 'lire_stock');
  assert.equal(e.etapes[2].arguments, undefined);
  assert.equal(e.actions[0].etat, 'proposee');
  assert.equal(validerExecution(e).ok, true);
});

test('construireExecution : option explicite pour le contenu, masqué à l\'envoi', () => {
  const e = construireExecution(bilan, { inclureContenu: true });
  assert.ok(e.question?.includes('jean@client.fr'));
  assert.ok(e.etapes[2].arguments?.includes('sku'));
  const v = validerExecution(e);
  assert.ok(v.ok && v.execution.question?.includes('[email]') && !v.execution.question.includes('jean@'));
});

test('construireExecution : erreur réduite à un code', () => {
  const e = construireExecution({ ...bilan, statut: 'erreur', codeErreur: 'Le client jean@x.fr a échoué' });
  assert.equal(e.erreur, 'erreur');
  assert.equal(construireExecution({ ...bilan, statut: 'erreur', codeErreur: 'ia_indisponible' }).erreur, 'ia_indisponible');
  const t = construireExecution({ ...bilan, tours: [{ modele: 'm', succes: false, codeErreur: 'http_500' }], outils: [{ outil: 'x', succes: false }] });
  assert.equal(t.etapes[0].codeErreur, 'http_500');
  assert.equal(t.etapes[1].codeErreur, 'erreur');
});

test('validerExecution : clé inconnue, statut inconnu et listes bornées', () => {
  const e = exec();
  assert.equal(validerExecution({ ...e, secret: 1 }).ok, false);
  assert.equal(validerExecution({ ...e, statut: 'ko' }).ok, false);
  assert.equal(validerExecution({ ...e, etapes: [{ type: 'tour_modele', extra: 1 }] }).ok, false);
  const longue = validerExecution({ ...e, etapes: Array.from({ length: 600 }, () => ({ type: 'resume_contexte' })) });
  assert.ok(longue.ok && longue.execution.etapes.length === 500);
  const src = validerExecution({ ...e, sources: [{ titre: 't', url: 'https://x.fr/a?token=1#f' }] });
  assert.ok(src.ok && src.execution.sources[0].url === 'https://x.fr/a');
  assert.equal(validerExecution({ ...e, sources: [{ titre: 't', url: 'https://u:p@x.fr/' }] }).ok, false);
  assert.equal(validerExecution({ ...e, sources: [{ titre: 't' }] }).ok, false);
});

test('dateJournal : à la seconde, en UTC', () => {
  assert.equal(dateJournal('2026-10-16T10:00:00.999+02:00'), '2026-10-16T08:00:00Z');
  assert.equal(dateJournal('pas une date'), null);
});

test('envoyer : POST /v1/agents avec la clé, lots de 100 au plus', async () => {
  const t = transportFactice();
  const j = creerJournalAgents({ adresse: 'https://c.exemple.fr/', cle: 'clj_pub_x', transport: t.transport, minuterie: false });
  const r = await j.envoyer(Array.from({ length: 230 }, (_, i) => ({ ...exec(), identifiantExterne: `r-${i}` })));
  assert.deepEqual(r, { acceptees: 230, refusees: 0 });
  assert.equal(t.requetes.length, 3);
  assert.equal(t.requetes[0].url, 'https://c.exemple.fr/v1/agents');
  assert.equal(t.requetes[0].entetes['X-Centrale-Cle'], 'clj_pub_x');
  assert.deepEqual(t.requetes.map((q) => JSON.parse(q.corps).executions.length), [100, 100, 30]);
  assert.equal(j.enAttente(), 0);
});

test('envoyer : une clé inconnue est refusée en local, sans envoi', async () => {
  const t = transportFactice();
  const j = creerJournalAgents({ adresse: 'https://c.exemple.fr', cle: 'clj_pub_x', transport: t.transport, minuterie: false });
  const r = await j.envoyer([{ ...exec(), intrus: true } as unknown as ExecutionAgent]);
  assert.deepEqual(r, { acceptees: 0, refusees: 1 });
  assert.equal(t.requetes.length, 0);
});

test('file : 5xx ou réseau => remise en file avec recul ; reprise ensuite', async () => {
  const t = transportFactice();
  const h = horloge();
  t.reponses.push({ statut: 503 }, () => { throw new Error('hors ligne'); });
  const j = creerJournalAgents({ adresse: 'https://c.exemple.fr', cle: 'clj_pub_x', transport: t.transport, minuterie: false, maintenant: h.maintenant });
  await j.envoyer([exec()]);
  assert.equal(j.enAttente(), 1);
  await j.vider(); // dans le recul : rien
  assert.equal(t.requetes.length, 1);
  h.avancer(2_001);
  await j.vider(); // deuxième échec, recul doublé (4 s)
  assert.equal(t.requetes.length, 2);
  h.avancer(2_001);
  await j.vider();
  assert.equal(t.requetes.length, 2);
  h.avancer(2_000);
  await j.vider();
  assert.equal(t.requetes.length, 3);
  assert.equal(j.enAttente(), 0);
});

test('file : 429 respecte Retry-After ; 4xx abandonne en silence', async () => {
  const t = transportFactice();
  const h = horloge();
  t.reponses.push({ statut: 429, reessayerApres: '30' });
  const j = creerJournalAgents({ adresse: 'https://c.exemple.fr', cle: 'clj_pub_x', transport: t.transport, minuterie: false, maintenant: h.maintenant });
  await j.envoyer([exec()]);
  h.avancer(29_000); await j.vider();
  assert.equal(t.requetes.length, 1);
  t.reponses.push({ statut: 401 });
  h.avancer(2_000); await j.vider();
  assert.equal(t.requetes.length, 2);
  assert.equal(j.enAttente(), 0);
});

test('ne lève jamais : adresse invalide, fetch qui lève, entrées absurdes', async () => {
  const inactif = creerJournalAgents({ adresse: 'pas-une-adresse', cle: 'k' });
  assert.deepEqual(await inactif.envoyer([exec()]), { acceptees: 0, refusees: 0 });
  const j = creerJournalAgents({ adresse: 'https://c.exemple.fr', cle: 'k', minuterie: false, fetch: (async () => { throw new Error('x'); }) as typeof fetch });
  assert.deepEqual(await j.envoyer([exec(), null as unknown as ExecutionAgent]), { acceptees: 1, refusees: 1 });
  assert.equal(j.enAttente(), 1);
  await j.envoyer(undefined as unknown as ExecutionAgent[]);
  j.arreter();
  assert.equal(j.enAttente(), 0);
});

test('fetch injecté : en-tête, corps et statut lus', async () => {
  const vus: Array<{ url: string; cle: string | null; corps: string }> = [];
  const f = (async (url: string, init: RequestInit) => {
    vus.push({ url, cle: (init.headers as Record<string, string>)['X-Centrale-Cle'], corps: String(init.body) });
    return new Response('{"recus":1}', { status: 202 });
  }) as unknown as typeof fetch;
  const j = creerJournalAgents({ adresse: 'https://c.exemple.fr', cle: 'clj_pub_x', fetch: f, minuterie: false });
  await j.envoyer([exec()]);
  assert.equal(vus[0].url, 'https://c.exemple.fr/v1/agents');
  assert.equal(vus[0].cle, 'clj_pub_x');
  assert.equal(JSON.parse(vus[0].corps).executions[0].agent, 'Elsa');
  assert.equal(j.enAttente(), 0);
});
