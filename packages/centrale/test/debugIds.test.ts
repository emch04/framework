import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EvenementErreur } from '../src/envoi.ts';
import { creerCentrale } from '../src/coeur.ts';
import { associerDebugIds, debugIdsParFichier, GLOBALE_DEBUG_IDS } from '../src/debugIds.ts';
import { CONFIG, transportFactice } from './aides.ts';

const ID_INDEX = '1b4e28ba-2fa1-4d2e-883f-0016d3cca427';
const ID_VENDOR = '6fa459ea-ee8a-4ca4-894e-db77e160355e';
const globale = globalThis as Record<string, unknown>;

afterEach(() => { delete globale[GLOBALE_DEBUG_IDS]; });

/** Ce qu'aurait enregistré la ligne injectée par `centrale injecter`, dans Chrome et dans Safari. */
function enregistrer() {
  globale[GLOBALE_DEBUG_IDS] = {
    'Error\n    at https://app.exemple.test/assets/index-BxK3_9aZ.js:1:57\n    at https://app.exemple.test/assets/index-BxK3_9aZ.js:1:300': ID_INDEX,
    'global code@https://app.exemple.test/assets/vendor-9f8e7d6c.js:1:44': ID_VENDOR
  };
}

function erreurDansDeuxFichiers(): Error {
  const e = new TypeError('x is undefined');
  e.stack = 'TypeError: x is undefined\n    at n (https://app.exemple.test/assets/index-BxK3_9aZ.js:1:4120)\n    at r (https://app.exemple.test/assets/vendor-9f8e7d6c.js:1:880)\n    at https://app.exemple.test/autre.js:3:1';
  return e;
}

test('les piles enregistrées donnent la table fichier → identifiant, quel que soit le moteur', () => {
  assert.equal(debugIdsParFichier().size, 0, 'rien d\'injecté : table vide');
  enregistrer();
  const table = debugIdsParFichier();
  assert.equal(table.get('https://app.exemple.test/assets/index-BxK3_9aZ.js'), ID_INDEX);
  assert.equal(table.get('https://app.exemple.test/assets/vendor-9f8e7d6c.js'), ID_VENDOR);
});

test('un fichier chargé plus tard (découpage du code) est pris en compte', () => {
  enregistrer();
  assert.equal(debugIdsParFichier().size, 2);
  (globale[GLOBALE_DEBUG_IDS] as Record<string, string>)['Error\n    at https://app.exemple.test/assets/eleve-Aa11Bb22.js:1:10'] = 'id-tardif';
  assert.equal(debugIdsParFichier().get('https://app.exemple.test/assets/eleve-Aa11Bb22.js'), 'id-tardif');
});

test('une globale abîmée ne fait jamais lever', () => {
  globale[GLOBALE_DEBUG_IDS] = { 'pas une pile': 42, '': 'x' };
  assert.equal(debugIdsParFichier().size, 0);
  globale[GLOBALE_DEBUG_IDS] = 'n\'importe quoi';
  assert.deepEqual(associerDebugIds([{ fichier: 'a.js', app: true }]), undefined);
});

test('chaque cadre reçoit l\'identifiant de son fichier ; l\'erreur, seulement s\'il n\'y en a qu\'un', async () => {
  enregistrer();
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, { minuterie: false });
  c.erreur(erreurDansDeuxFichiers());
  const seulIndex = new Error('boum');
  seulIndex.stack = 'Error: boum\n    at a (https://app.exemple.test/assets/index-BxK3_9aZ.js:1:10)\n    at b (https://app.exemple.test/assets/index-BxK3_9aZ.js:1:99)';
  c.erreur(seulIndex);
  c.erreur(seulIndex, { debugId: 'impose' });
  await c.vider();
  const [deux, un, impose] = t.envois()[0].evenements as EvenementErreur[];
  assert.deepEqual(deux.exception.pile.map((x) => x.debugId), [ID_INDEX, ID_VENDOR, undefined]);
  assert.equal(deux.debugId, undefined, 'deux fichiers : pas d\'identifiant commun');
  assert.equal(un.debugId, ID_INDEX);
  assert.equal(impose.debugId, 'impose', 'celui fourni par l\'appelant l\'emporte');
});

test('le masquage ne touche pas aux identifiants des cadres', async () => {
  // Un identifiant sans tirets ressemble à une empreinte : le masquage le remplacerait.
  const brut = 'a'.repeat(32);
  globale[GLOBALE_DEBUG_IDS] = { 'Error\n    at https://app.exemple.test/app.js:1:1': brut };
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, { minuterie: false });
  const e = new Error('boum');
  e.stack = 'Error: boum\n    at f (https://app.exemple.test/app.js:1:50)\n    at g (https://app.exemple.test/app.js:1:80)';
  c.erreur(e);
  await c.vider();
  const envoye = t.envois()[0].evenements[0] as EvenementErreur;
  assert.equal(envoye.exception.pile[0].debugId, brut);
  assert.equal(envoye.debugId, brut);
});

test('une pile fournie (plantage natif) n\'est pas modifiée chez l\'appelant', async () => {
  enregistrer();
  const pile = [{ fichier: 'https://app.exemple.test/assets/index-BxK3_9aZ.js', ligne: 1, colonne: 5, app: true }];
  const t = transportFactice();
  const c = creerCentrale(CONFIG, t.transport, { minuterie: false });
  c.erreur(new Error('natif'), { pile });
  await c.vider();
  assert.equal((t.envois()[0].evenements[0] as EvenementErreur).exception.pile[0].debugId, ID_INDEX);
  assert.equal((pile[0] as { debugId?: string }).debugId, undefined);
});
