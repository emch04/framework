import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EVENEMENTS_MAX_PAR_ENVOI, MIETTES_MAX, TAILLE_MAX_ENVOI } from '../src/envoi.ts';
import type { EvenementErreur, EvenementIA, EvenementSession, EvenementUsage, EvenementVue } from '../src/envoi.ts';
import { creerCentrale, VERSION_SDK } from '../src/coeur.ts';
import type { ReglagesInternes } from '../src/coeur.ts';
import { CONFIG, horloge, transportFactice } from './aides.ts';

const SANS_MINUTERIE: ReglagesInternes = { minuterie: false };

test('envoi : adresse, en-têtes, enveloppe conforme au contrat', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  c.usage('export', { format: 'pdf' });
  await c.vider();
  assert.equal(t.requetes.length, 1);
  const r = t.requetes[0];
  assert.equal(r.url, 'https://centrale.exemple.fr/v1/envoi');
  assert.equal(r.entetes['X-Centrale-Cle'], CONFIG.cle);
  assert.equal(r.entetes['Content-Type'], 'application/json');
  const envoi = t.envois()[0];
  assert.equal(envoi.version, 1);
  assert.deepEqual(envoi.sdk, { nom: '@astratra/centrale', version: VERSION_SDK });
  assert.equal(envoi.contexte.environnement, 'developpement');
  assert.equal(envoi.contexte.version, '1.2.3');
  assert.equal(envoi.contexte.plateforme, 'serveur');
  const usage = envoi.evenements[0] as EvenementUsage;
  assert.equal(usage.type, 'usage');
  assert.equal(usage.nom, 'export');
  assert.deepEqual(usage.proprietes, { format: 'pdf' });
  assert.ok(!Number.isNaN(Date.parse(usage.horodatage)));
  assert.equal(c.enAttente(), 0);
});

test('masquage appliqué avant envoi : message, miettes, propriétés, étiquettes, noms, adresses', async () => {
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, noms: ['Mbappé Lefèvre'] }, t.transport, SANS_MINUTERIE);
  c.miette('requete', 'appel avec Bearer abcdefghijklmnop pour jean@exemple.fr');
  c.miette('autre', 'ok', { token: 'secret123', courriel: 'a@b.fr', n: 3 });
  c.erreur(new Error('Échec pour jean.dupont@exemple.fr, tél +33 6 12 34 56 78, élève Mbappé Lefèvre, clé sk-proj-abcdefghijkl'), {
    etiquettes: { carte: '4111 1111 1111 1111', password: 'hunter2' },
    requete: { methode: 'GET', route: '/eleve/123?token=abc' }
  });
  c.usage('recherche', { requete: 'mail de x@y.com', objet: { profond: true } });
  c.vue('/eleve/42/notes?token=zzz#haut');
  await c.vider();
  const texte = t.requetes.map((r) => r.corps).join('');
  for (const fuite of ['jean.dupont@exemple.fr', 'jean@exemple.fr', '12 34 56 78', 'Mbappé Lefèvre', 'sk-proj-abcdefghijkl', 'abcdefghijklmnop',
    '4111 1111 1111 1111', 'hunter2', 'secret123', 'a@b.fr', 'x@y.com', 'token=abc', 'zzz']) {
    assert.ok(!texte.includes(fuite), `fuite : ${fuite}`);
  }
  const [erreur, usage, vue] = t.envois()[0].evenements as [EvenementErreur, EvenementUsage, EvenementVue];
  assert.match(erreur.exception.message, /\[email\].*\[telephone\].*\[nom\].*\[cle\]/);
  assert.equal(erreur.etiquettes?.password, '[masque]');
  assert.equal(erreur.etiquettes?.carte, '[carte]');
  assert.equal(erreur.requete?.route, '/eleve/:id');
  assert.equal(erreur.filAriane?.length, 2);
  assert.match(erreur.filAriane![0].message, /Bearer \[jeton\] pour \[email\]/);
  assert.deepEqual(erreur.filAriane![1].donnees, { token: '[masque]', courriel: '[email]', n: 3 });
  // Seules les valeurs simples passent : l'objet imbriqué est écarté.
  assert.deepEqual(usage.proprietes, { requete: 'mail de [email]' });
  assert.equal(vue.nom, '/eleve/:id/notes');
  // L'identifiant d'événement (UUID) n'est pas pris pour un secret.
  assert.match(erreur.id, /^[0-9a-f-]{36}$/);
});

test('le debugId et les identifiants techniques survivent au masquage', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  const debugId = 'a'.repeat(32);
  c.erreur(new Error('x'), { debugId });
  await c.vider();
  assert.equal((t.envois()[0].evenements[0] as EvenementErreur).debugId, debugId);
});

test('lots : au plus EVENEMENTS_MAX_PAR_ENVOI par envoi, ordre conservé', async () => {
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, file: { max: 1000 } }, t.transport, SANS_MINUTERIE);
  for (let i = 0; i < 250; i++) c.usage(`u${i}`);
  await c.vider();
  const tailles = t.envois().map((e) => e.evenements.length);
  assert.deepEqual(tailles, [EVENEMENTS_MAX_PAR_ENVOI, EVENEMENTS_MAX_PAR_ENVOI, 50]);
  const noms = t.envois().flatMap((e) => e.evenements.map((ev) => (ev as EvenementUsage).nom));
  assert.equal(noms[0], 'u0');
  assert.equal(noms[249], 'u249');
});

test('lots : un envoi ne dépasse jamais TAILLE_MAX_ENVOI ; un événement trop gros est abandonné', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  const gros = 'x'.repeat(3000); // borné à 4000 caractères par message
  for (let i = 0; i < 100; i++) {
    const e = new Error(gros);
    e.stack = `Error: x\n${Array.from({ length: 100 }, (_, j) => `    at f${j} (/app/${'d'.repeat(60)}/fichier${j}.js:1:1)`).join('\n')}`;
    c.erreur(e);
  }
  await c.vider();
  assert.ok(t.requetes.length > 1);
  for (const r of t.requetes) assert.ok(Buffer.byteLength(r.corps) <= TAILLE_MAX_ENVOI);
  assert.equal(t.envois().reduce((n, e) => n + e.evenements.length, 0), 100);

  // Un seul événement de plus de TAILLE_MAX_ENVOI (beaucoup d'étiquettes) : abandonné, la file continue.
  const t2 = transportFactice();
  const c2 = creerCentrale(CONFIG, t2.transport, SANS_MINUTERIE);
  c2.erreur(new Error('énorme'), { etiquettes: Object.fromEntries(Array.from({ length: 8000 }, (_, i) => [`e${i}`, 'v'.repeat(190)])) });
  c2.erreur(new Error('normale'));
  await c2.vider();
  assert.equal(c2.enAttente(), 0);
  assert.deepEqual(t2.envois().flatMap((e) => e.evenements.map((ev) => (ev as EvenementErreur).exception.message)), ['normale']);
});

test('lots : un nouveau contexte (utilisateur) part dans un autre envoi', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  c.usage('avant');
  c.definirUtilisateur('u-1');
  c.usage('apres');
  await c.vider();
  const envois = t.envois();
  assert.equal(envois.length, 2);
  assert.equal(envois[0].contexte.utilisateur, undefined);
  assert.equal(envois[1].contexte.utilisateur?.length, 64);
});

test('vidage automatique au seuil de 50 événements et à l\'intervalle', async () => {
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, file: { intervalleMs: 60_000 } }, t.transport);
  for (let i = 0; i < 49; i++) c.usage('u');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.requetes.length, 0, 'rien avant le seuil');
  c.usage('u');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.requetes.length, 1);
  assert.equal(t.envois()[0].evenements.length, 50);
  c.arreter();

  const t2 = transportFactice();
  const c2 = creerCentrale({ ...CONFIG, file: { intervalleMs: 15 } }, t2.transport);
  c2.usage('seul');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t2.requetes.length, 1);
  c2.arreter();
});

test('file bornée : les plus vieux usages partent d\'abord, jamais une erreur avant un usage', async () => {
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, file: { max: 5 } }, t.transport, SANS_MINUTERIE);
  c.erreur(new Error('e1'));
  c.usage('u1');
  c.session('debut');
  c.usage('u2');
  c.erreur(new Error('e2'));
  c.usage('u3'); // déborde : u1 part
  c.vue('/v'); // déborde : u2 part
  assert.equal(c.enAttente(), 5);
  await c.vider();
  const evs = t.envois().flatMap((e) => e.evenements);
  const resume = evs.map((e) => e.type === 'erreur' ? (e as EvenementErreur).exception.message : e.type === 'usage' ? (e as EvenementUsage).nom : e.type);
  assert.deepEqual(resume.sort(), ['e1', 'e2', 'session', 'u3', 'vue'].sort());

  // Une file pleine d'erreurs : un nouvel usage est jeté, pas une erreur.
  const t2 = transportFactice();
  const c2 = creerCentrale({ ...CONFIG, file: { max: 3 } }, t2.transport, SANS_MINUTERIE);
  for (let i = 0; i < 3; i++) c2.erreur(new Error(`e${i}`));
  c2.usage('trop');
  await c2.vider();
  assert.deepEqual(t2.envois().flatMap((e) => e.evenements.map((ev) => ev.type)), ['erreur', 'erreur', 'erreur']);
  // Et une erreur de plus remplace la plus vieille erreur.
  const t3 = transportFactice();
  const c3 = creerCentrale({ ...CONFIG, file: { max: 2 } }, t3.transport, SANS_MINUTERIE);
  c3.erreur(new Error('a')); c3.erreur(new Error('b')); c3.erreur(new Error('c'));
  await c3.vider();
  assert.deepEqual(t3.envois()[0].evenements.map((e) => (e as EvenementErreur).exception.message), ['b', 'c']);
});

test('recul progressif sur échec (5xx, réseau), plafonné, puis reprise', async () => {
  const h = horloge();
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, file: { reculBaseMs: 1000, reculMaxMs: 5000 } }, t.transport, { ...SANS_MINUTERIE, maintenant: h.maintenant });
  c.usage('u');
  t.reponses.push({ statut: 503 }, () => { throw new Error('réseau coupé'); }, { statut: 500 }, { statut: 502 }, { statut: 500 });
  const attentes: number[] = [];
  for (let i = 0; i < 5; i++) {
    await c.vider();
    assert.equal(c.enAttente(), 1, 'l\'événement reste en file');
    // Tant que la pause court, rien ne part.
    const avant = t.requetes.length;
    let attendu = 0;
    while (true) {
      await c.vider();
      if (t.requetes.length > avant) break;
      h.avancer(250);
      attendu += 250;
      if (attendu > 10_000) assert.fail('jamais repris');
    }
    attentes.push(attendu);
  }
  // 1 s, 2 s, 4 s, puis plafond à 5 s ; le 6e essai (202) vide la file.
  assert.deepEqual(attentes, [1000, 2000, 4000, 5000, 5000]);
  assert.equal(c.enAttente(), 0);
  assert.equal(t.requetes.length, 6);
});

test('429 : respect de Retry-After (secondes et date HTTP)', async () => {
  const h = horloge();
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, { ...SANS_MINUTERIE, maintenant: h.maintenant });
  c.usage('u');
  t.reponses.push({ statut: 429, reessayerApres: '30' });
  await c.vider();
  h.avancer(29_000);
  await c.vider();
  assert.equal(t.requetes.length, 1, 'rien avant 30 s');
  t.reponses.push({ statut: 429, reessayerApres: new Date(h.maintenant() + 1000 + 60_000).toUTCString() });
  h.avancer(1000);
  await c.vider();
  assert.equal(t.requetes.length, 2);
  h.avancer(59_000);
  await c.vider();
  assert.equal(t.requetes.length, 2, 'la date HTTP est respectée');
  h.avancer(1000);
  await c.vider();
  assert.equal(t.requetes.length, 3);
  assert.equal(c.enAttente(), 0);
});

test('400, 401 et 413 : abandon silencieux du lot, la suite continue', async () => {
  for (const statut of [400, 401, 413]) {
    const t = transportFactice();
    const c = creerCentrale({ ...CONFIG, file: { max: 1000 } }, t.transport, SANS_MINUTERIE);
    for (let i = 0; i < 150; i++) c.usage(`u${i}`);
    t.reponses.push({ statut });
    await c.vider();
    assert.equal(t.requetes.length, 2, `statut ${statut}`);
    assert.equal(c.enAttente(), 0);
  }
});

test('hors ligne : la file attend, puis part', async () => {
  let enLigne = false;
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, { ...SANS_MINUTERIE, enLigne: () => enLigne });
  c.erreur(new Error('hors ligne'));
  await c.vider();
  assert.equal(t.requetes.length, 0);
  assert.equal(c.enAttente(), 1);
  enLigne = true;
  await c.vider();
  assert.equal(t.requetes.length, 1);
});

test('échantillonnage : vues, usages et IA réduits ; erreurs et sessions jamais', async () => {
  const t = transportFactice();
  let n = 0;
  const aleatoire = () => (n++ % 10) / 10; // 0, 0.1, … 0.9
  const c = creerCentrale({ ...CONFIG, file: { max: 2000 }, echantillonnage: { vues: 0.3, usages: 0, ia: 0.5 } }, t.transport, { ...SANS_MINUTERIE, aleatoire });
  for (let i = 0; i < 100; i++) c.vue('/v');
  for (let i = 0; i < 100; i++) c.usage('u');
  for (let i = 0; i < 100; i++) c.ia({ fournisseur: 'f', modele: 'm', dureeMs: 1, resultat: 'ok' });
  for (let i = 0; i < 100; i++) c.erreur(new Error('e'));
  c.session('debut');
  c.session('ok');
  await c.vider();
  const compte = (type: string) => t.envois().flatMap((e) => e.evenements).filter((e) => e.type === type).length;
  assert.equal(compte('vue'), 30);
  assert.equal(compte('usage'), 0);
  assert.equal(compte('ia'), 50);
  assert.equal(compte('erreur'), 100);
  assert.equal(compte('session'), 2);

  // Même avec un taux à 0 partout, une erreur passe.
  const t2 = transportFactice();
  const c2 = creerCentrale({ ...CONFIG, echantillonnage: { vues: 0, usages: 0, ia: 0 } }, t2.transport, { ...SANS_MINUTERIE, aleatoire: () => 0.99 });
  c2.erreur('chaîne lancée');
  await c2.vider();
  assert.equal(t2.envois()[0].evenements[0].type, 'erreur');
});

test('utilisateur haché avec le sel, jamais l\'identifiant brut ; effacement ; mode strict', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  c.definirUtilisateur('eleve-98765');
  c.erreur(new Error('x'));
  c.definirUtilisateur(null);
  c.usage('apres');
  await c.vider();
  const attendu = createHash('sha256').update('sel-du-projet:eleve-98765').digest('hex');
  assert.equal(t.envois()[0].contexte.utilisateur, attendu);
  assert.ok(!t.requetes.some((r) => r.corps.includes('eleve-98765')));
  assert.equal(t.envois()[1].contexte.utilisateur, undefined);

  const t2 = transportFactice();
  const strict = creerCentrale({ ...CONFIG, strict: true, contexte: { appareil: 'iPhone de Camille', os: 'iOS 26' } }, t2.transport, SANS_MINUTERIE);
  strict.definirUtilisateur('eleve-1');
  strict.definirContexte({ appareil: 'iPhone16,2' });
  strict.erreur(new Error('x'));
  await strict.vider();
  const ctx = t2.envois()[0].contexte;
  assert.equal(ctx.utilisateur, undefined);
  assert.equal(ctx.appareil, undefined);
  assert.equal(ctx.os, 'iOS 26');
});

test('desactive : rien n\'est gardé ni envoyé', async () => {
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, desactive: true }, t.transport);
  assert.equal(c.actif, false);
  c.erreur(new Error('x')); c.usage('u'); c.vue('/'); c.session('debut'); c.miette('autre', 'm'); c.definirUtilisateur('u');
  c.ia({ fournisseur: 'f', modele: 'm', dureeMs: 1, resultat: 'ok' });
  await c.vider();
  assert.equal(c.enAttente(), 0);
  assert.equal(t.requetes.length, 0);
});

test('aucune exception ne remonte : transport qui lève, transport synchrone fautif, entrées absurdes', async () => {
  const fautif = (() => { throw new Error('transport cassé'); }) as never;
  const c = creerCentrale(CONFIG, fautif, SANS_MINUTERIE);
  assert.doesNotThrow(() => {
    c.erreur(undefined);
    c.erreur(null);
    c.erreur(42);
    c.erreur({ toString() { throw new Error('piège'); } });
    c.erreur(Object.create(null));
    const cyclique: Record<string, unknown> = {}; cyclique.moi = cyclique;
    c.usage('u', cyclique);
    c.usage(undefined as never, null as never);
    c.vue(undefined as never);
    c.ia(null as never);
    c.miette('inconnue' as never, undefined as never, { f: () => 1 });
    c.session('ok');
    c.definirUtilisateur({} as never);
    c.definirContexte(null as never);
  });
  await assert.doesNotReject(c.vider());
  const rejet = creerCentrale(CONFIG, () => Promise.reject(new Error('rejet')), SANS_MINUTERIE);
  rejet.erreur(new Error('x'));
  await assert.doesNotReject(rejet.vider());
  assert.equal(rejet.enAttente(), 1);
  // Configuration absente : instance inactive, pas d'exception.
  assert.doesNotThrow(() => creerCentrale(undefined as never).erreur(new Error('x')));
});

test('fil d\'Ariane borné à MIETTES_MAX, copié dans l\'erreur', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  for (let i = 0; i < MIETTES_MAX + 20; i++) c.miette('clic', `clic ${i}`);
  c.erreur(new Error('x'));
  await c.vider();
  const fil = (t.envois()[0].evenements[0] as EvenementErreur).filAriane!;
  assert.equal(fil.length, MIETTES_MAX);
  assert.equal(fil[0].message, 'clic 20');
  assert.equal(fil.at(-1)!.message, `clic ${MIETTES_MAX + 19}`);
  assert.equal(fil[0].categorie, 'clic');
});

test('erreur : type, message, pile lue avec app, valeurs lancées non-Error, extras', async () => {
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, racine: '/srv/app' }, t.transport, SANS_MINUTERIE);
  const e = new TypeError('mauvais type');
  e.stack = 'TypeError: mauvais type\n    at lire (/srv/app/src/lire.ts:10:5)\n    at Layer.handle (/srv/app/node_modules/express/lib/router/layer.js:95:5)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)';
  const id = c.erreur(e, { niveau: 'fatal', empreinte: ['lecture'], horodatage: '2026-01-02T03:04:05.000Z' });
  c.erreur('texte lancé');
  c.erreur(404);
  await c.vider();
  const [a, b, d] = t.envois()[0].evenements as EvenementErreur[];
  assert.equal(a.id, id);
  assert.equal(a.niveau, 'fatal');
  assert.equal(a.horodatage, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(a.empreinte, ['lecture']);
  assert.equal(a.exception.type, 'TypeError');
  assert.deepEqual(a.exception.pile.map((p) => [p.fichier, p.app]), [
    ['src/lire.ts', true],
    ['node_modules/express/lib/router/layer.js', false],
    ['node:internal/process/task_queues', false]
  ]);
  assert.deepEqual([b.exception.type, b.exception.message], ['Error', 'texte lancé']);
  assert.deepEqual([d.exception.type, d.exception.message], ['ValeurLancee', '404']);
});

test('sessions : début, fin avec durée, « ok » devient « erreur » après une erreur', async () => {
  const h = horloge();
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, { ...SANS_MINUTERIE, maintenant: h.maintenant });
  c.session('ok'); // sans session : ignoré
  c.session('debut');
  const id = c.sessionCourante();
  assert.ok(id);
  h.avancer(5000);
  c.session('ok');
  assert.equal(c.sessionCourante(), undefined);
  c.session('debut');
  c.erreur(new Error('x'));
  h.avancer(1000);
  c.session('ok');
  await c.vider();
  const evs = t.envois().flatMap((e) => e.evenements).filter((e) => e.type === 'session') as EvenementSession[];
  assert.deepEqual(evs.map((e) => [e.etat, e.dureeMs]), [['debut', undefined], ['ok', 5000], ['debut', undefined], ['erreur', 1000]]);
  assert.equal(evs[0].id, id);
  assert.equal(evs[1].id, id);
  // L'événement de fin part avec le contexte de sa session.
  assert.equal(t.envois()[0].contexte.sessionId, id);
});

test('ia : liste blanche des champs, aucun contenu ne passe', async () => {
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, SANS_MINUTERIE);
  c.ia({ fournisseur: 'anthropic', modele: 'claude', dureeMs: 1234.6, jetonsEntree: 10, jetonsSortie: -1, resultat: 'ok', outil: 'oracle', messages: ['secret'] } as never);
  await c.vider();
  const ev = t.envois()[0].evenements[0] as EvenementIA;
  assert.deepEqual(ev, { type: 'ia', horodatage: ev.horodatage, fournisseur: 'anthropic', modele: 'claude', dureeMs: 1235, resultat: 'ok', jetonsEntree: 10, outil: 'oracle' });
});

test('viderParBalise : adresse avec ?cle=, lots sous la taille, remise en file si refus', () => {
  const recus: Array<[string, string]> = [];
  const c = creerCentrale({ ...CONFIG, file: { max: 1000 } }, transportFactice().transport, SANS_MINUTERIE);
  for (let i = 0; i < 300; i++) c.usage(`usage-${i}`, { a: 'x'.repeat(100) });
  c.viderParBalise((url, corps) => { recus.push([url, corps]); return true; }, 20_000);
  assert.equal(c.enAttente(), 0);
  assert.ok(recus.length > 2);
  for (const [url, corps] of recus) {
    assert.equal(url, `https://centrale.exemple.fr/v1/envoi?cle=${CONFIG.cle}`);
    assert.ok(Buffer.byteLength(corps) <= 20_000);
  }
  c.usage('refus');
  c.viderParBalise(() => false);
  assert.equal(c.enAttente(), 1);
  c.viderParBalise(() => { throw new Error('balise cassée'); });
  assert.equal(c.enAttente(), 1);
});

test('contexte : definirContexte complète et masque, sans toucher à l\'utilisateur ni à l\'environnement', async () => {
  const t = transportFactice();
  const c = creerCentrale({ ...CONFIG, plateforme: 'web' }, t.transport, SANS_MINUTERIE);
  c.definirContexte({ langue: 'fr-FR', os: 'macOS', appareil: 'Mac de jean@exemple.fr', environnement: 'production', utilisateur: 'brut' } as never);
  c.usage('u');
  await c.vider();
  const ctx = t.envois()[0].contexte;
  assert.equal(ctx.langue, 'fr-FR');
  assert.equal(ctx.plateforme, 'web');
  assert.equal(ctx.environnement, 'developpement');
  assert.equal(ctx.utilisateur, undefined);
  assert.equal(ctx.appareil, 'Mac de [email]');
});

test('VERSION_SDK suit la version du paquet : le tableau de bord sait quelle version a envoyé', async () => {
  const { readFileSync } = await import('node:fs');
  const paquet = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(VERSION_SDK, paquet.version);
});
