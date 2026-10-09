import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masquerTexte, masquerValeur } from '../src/masquage.ts';

/* Un texte piégé ne doit jamais figer le serveur : chaque règle reste linéaire, même sur des
   chaînes longues sans séparateur (la règle e-mail était quadratique, 9 octobre 2026). */
test('le masquage reste rapide sur des textes piégés de 10 000 caractères', () => {
  const pieges = [
    'a'.repeat(10_000),
    'a.'.repeat(5_000),
    'a@'.repeat(5_000),
    '@'.repeat(10_000),
    'a@b'.repeat(3_333),
    '1'.repeat(10_000),
    '1 '.repeat(5_000),
    'f'.repeat(10_000),
    'eyJ'.repeat(3_333),
    'FR76'.repeat(2_500)
  ];
  const debut = performance.now();
  for (let i = 0; i < 10; i++) for (const texte of pieges) masquerTexte(texte);
  const duree = performance.now() - debut;
  assert.ok(duree < 1_000, `100 textes piégés masqués en ${Math.round(duree)} ms`);
});

test('les adresses e-mail sont toujours masquées, et un texte sans arobase est laissé tel quel', () => {
  assert.equal(masquerTexte('écrire à jean.dupont+test@exemple.fr demain'), 'écrire à [email] demain');
  assert.equal(masquerTexte('aucune adresse ici'), 'aucune adresse ici');
  assert.deepEqual(masquerValeur({ contact: 'a.b@c.org', n: 1 }), { contact: '[email]', n: 1 });
});
