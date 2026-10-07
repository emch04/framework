/**
 * Processus enfant des tests Node : démarre la collecte vers ADRESSE puis provoque
 * le cas demandé (exception, rejet, signal, sortie normale).
 */

import { demarrer } from '../../src/node.ts';

const centrale = demarrer({
  cle: 'clj_pub_enfant1234567890',
  adresse: process.env.ADRESSE ?? 'http://127.0.0.1:9',
  environnement: 'developpement',
  version: '9.9.9',
  file: { intervalleMs: 60_000 }
});

const cas = process.argv[2];
centrale.usage('demarrage');

if (cas === 'exception') {
  setTimeout(() => { throw new Error('exception non attrapée'); }, 10);
} else if (cas === 'rejet') {
  void Promise.reject(new Error('rejet sans gestionnaire'));
} else if (cas === 'rejet-gere') {
  // Un autre écouteur existe : Node ne plante pas, on enregistre seulement.
  process.on('unhandledRejection', () => {});
  void Promise.reject(new Error('rejet avec écouteur'));
} else if (cas === 'signal') {
  // Le processus attend ; le test lui envoie SIGTERM.
  setInterval(() => {}, 1000);
  process.stdout.write('pret\n');
} else if (cas === 'sortie') {
  centrale.erreur(new Error('erreur gérée'));
  // Rien d'autre : beforeExit doit vider la file.
}
