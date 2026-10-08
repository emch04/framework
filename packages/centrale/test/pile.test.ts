import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CADRES_MAX } from '../src/envoi.ts';
import { analyserPile, estFichierApp } from '../src/pile.ts';

test('V8 / Node : fonctions, anonymes, async, new, internes, node_modules, racine', () => {
  const pile = [
    'TypeError: Cannot read properties of undefined (reading \'x\')',
    '    at lireEleve (/srv/app/src/eleves.ts:42:13)',
    '    at async Promise.all (index 0)',
    '    at async chargerTout (file:///srv/app/src/charger.ts:7:3)',
    '    at new Service (/srv/app/src/service.ts:3:9)',
    '    at /srv/app/src/anonyme.ts:1:2',
    '    at Layer.handle [as handle_request] (/srv/app/node_modules/express/lib/router/layer.js:95:5)',
    '    at Object.<anonymous> (C:\\projets\\app\\index.js:5:1)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    '    at Module._compile (internal/modules/cjs/loader.js:999:30)',
    '    at Array.map (<anonymous>)',
    '    at eval (eval at construire (/srv/app/src/dyn.ts:4:5), <anonymous>:1:1)',
    '    at JSON.parse (native)'
  ].join('\n');
  const cadres = analyserPile(pile, { racine: '/srv/app/' });
  assert.deepEqual(cadres, [
    { fichier: 'src/eleves.ts', fonction: 'lireEleve', ligne: 42, colonne: 13, app: true },
    { fichier: '<interne>', fonction: 'Promise.all', app: false },
    { fichier: 'src/charger.ts', fonction: 'chargerTout', ligne: 7, colonne: 3, app: true },
    { fichier: 'src/service.ts', fonction: 'new Service', ligne: 3, colonne: 9, app: true },
    { fichier: 'src/anonyme.ts', ligne: 1, colonne: 2, app: true },
    { fichier: 'node_modules/express/lib/router/layer.js', fonction: 'Layer.handle [as handle_request]', ligne: 95, colonne: 5, app: false },
    { fichier: 'C:\\projets\\app\\index.js', fonction: 'Object.<anonymous>', ligne: 5, colonne: 1, app: true },
    { fichier: 'node:internal/process/task_queues', fonction: 'process.processTicksAndRejections', ligne: 105, colonne: 5, app: false },
    { fichier: 'internal/modules/cjs/loader.js', fonction: 'Module._compile', ligne: 999, colonne: 30, app: false },
    { fichier: '<anonymous>', fonction: 'Array.map', app: false },
    { fichier: 'src/dyn.ts', fonction: 'eval', ligne: 4, colonne: 5, app: true },
    { fichier: 'native', fonction: 'JSON.parse', app: false }
  ]);
});

test('V8 / Chrome : adresses web sans requête, extensions marquées hors app', () => {
  const pile = [
    'Error: boum',
    '    at HTMLButtonElement.surClic (https://app.exemple.fr/assets/index-4f2a.js:12:3456)',
    '    at https://app.exemple.fr/assets/vendeur.js?v=3&token=abc:1:99',
    '    at f (https://cdn.exemple.fr/node_modules/react-dom/cjs/react-dom.js:10:1)',
    '    at chrome-extension://abcdef/contenu.js:4:2'
  ].join('\n');
  assert.deepEqual(analyserPile(pile), [
    { fichier: 'https://app.exemple.fr/assets/index-4f2a.js', fonction: 'HTMLButtonElement.surClic', ligne: 12, colonne: 3456, app: true },
    { fichier: 'https://app.exemple.fr/assets/vendeur.js', ligne: 1, colonne: 99, app: true },
    { fichier: 'https://cdn.exemple.fr/node_modules/react-dom/cjs/react-dom.js', fonction: 'f', ligne: 10, colonne: 1, app: false },
    { fichier: 'chrome-extension://abcdef/contenu.js', ligne: 4, colonne: 2, app: false }
  ]);
});

test('Safari (JavaScriptCore) : fonction@fichier, code global, code natif', () => {
  const pile = [
    'surClic@https://app.exemple.fr/assets/index.js:12:3456',
    'forEach@[native code]',
    '@https://app.exemple.fr/assets/index.js:1:10',
    'global code@https://app.exemple.fr/:5:7',
    'f@webkit-masked-url://hidden/:1:1',
    '[native code]'
  ].join('\n');
  assert.deepEqual(analyserPile(pile), [
    { fichier: 'https://app.exemple.fr/assets/index.js', fonction: 'surClic', ligne: 12, colonne: 3456, app: true },
    { fichier: '[native code]', fonction: 'forEach', app: false },
    { fichier: 'https://app.exemple.fr/assets/index.js', ligne: 1, colonne: 10, app: true },
    { fichier: 'https://app.exemple.fr/', fonction: 'global code', ligne: 5, colonne: 7, app: true },
    { fichier: 'webkit-masked-url://hidden/', fonction: 'f', ligne: 1, colonne: 1, app: false },
    { fichier: '[native code]', app: false }
  ]);
});

test('Firefox (SpiderMonkey) : fonctions imbriquées, paquets à portée (@scope)', () => {
  const pile = [
    'lire/<@https://app.exemple.fr/src/lire.js:3:9',
    'appeler@https://app.exemple.fr/node_modules/@tanstack/query/build.js:8:1',
    'f@moz-extension://1234/script.js:1:1',
    ''
  ].join('\n');
  assert.deepEqual(analyserPile(pile), [
    { fichier: 'https://app.exemple.fr/src/lire.js', fonction: 'lire/<', ligne: 3, colonne: 9, app: true },
    { fichier: 'https://app.exemple.fr/node_modules/@tanstack/query/build.js', fonction: 'appeler', ligne: 8, colonne: 1, app: false },
    { fichier: 'moz-extension://1234/script.js', fonction: 'f', ligne: 1, colonne: 1, app: false }
  ]);
});

test('Hermes (React Native) : « address at »', () => {
  const pile = 'Error: x\n    at surAppui (address at index.android.bundle:1:234567)\n    at anonymous (address at index.android.bundle:1:99)';
  assert.deepEqual(analyserPile(pile), [
    { fichier: 'index.android.bundle', fonction: 'surAppui', ligne: 1, colonne: 234567, app: true },
    { fichier: 'index.android.bundle', ligne: 1, colonne: 99, app: true }
  ]);
});

test('pile réelle de Node : le cadre du test est app, ceux de node:test ne le sont pas', () => {
  const cadres = analyserPile(new Error('réelle').stack, { racine: process.cwd() });
  assert.ok(cadres.length > 0);
  assert.equal(cadres[0].app, true);
  assert.match(cadres[0].fichier, /pile\.test\.ts$/);
  assert.ok(cadres.some((c) => c.fichier.startsWith('node:') && !c.app));
});

test('bornes : au plus CADRES_MAX cadres ; entrées invalides => liste vide', () => {
  const pile = 'Error\n' + Array.from({ length: CADRES_MAX + 50 }, (_, i) => `    at f${i} (/a/b.js:${i + 1}:1)`).join('\n');
  assert.equal(analyserPile(pile).length, CADRES_MAX);
  assert.deepEqual(analyserPile(undefined), []);
  assert.deepEqual(analyserPile(42), []);
  assert.deepEqual(analyserPile(''), []);
  assert.deepEqual(analyserPile('juste un message'), []);
});

test('estFichierApp', () => {
  assert.equal(estFichierApp('/srv/app/src/a.ts'), true);
  assert.equal(estFichierApp('src/a.ts'), true);
  assert.equal(estFichierApp('/srv/app/node_modules/x/a.js'), false);
  assert.equal(estFichierApp('C:\\app\\node_modules\\x\\a.js'), false);
  assert.equal(estFichierApp('node:fs'), false);
  assert.equal(estFichierApp(''), false);
});
