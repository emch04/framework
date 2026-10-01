/** Outils partagés : serveur de test, clients Yjs bruts, attente d'une condition. */
const Y = require('yjs');
const { createCollabServer, createCollabProvider, createMemoryPersistence } = require('../src');

/* Jetons de test : chacun donne un droit fixe, quel que soit le document. */
const JETONS = {
  'jeton-ecriture': { access: 'write', user: { id: 'u-ecrivain' } },
  'jeton-ecriture-2': { access: 'write', user: { id: 'u-ecrivain-2' } },
  'jeton-lecture': { access: 'read', user: { id: 'u-lecteur' } }
};

async function demarrerServeur(options = {}) {
  const collab = createCollabServer({
    authenticate: async ({ token }) => JETONS[token] || 'none',
    persistence: options.persistence || createMemoryPersistence(),
    debounce: 50,
    maxDebounce: 200,
    ...options
  });
  const { url } = await collab.listen();
  return { collab, url };
}

/** Attend qu'une condition (synchrone ou asynchrone) devienne vraie. */
async function attendre(condition, { delai = 5000, pas = 10 } = {}) {
  const debut = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await condition();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - debut > delai) throw new Error('Condition jamais atteinte.');
    await new Promise((resolve) => setTimeout(resolve, pas));
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Client Yjs sans éditeur, connecté et synchronisé. */
async function client(url, name, token) {
  const document = new Y.Doc();
  const etat = { scope: null, refus: null, limite: null };
  const provider = createCollabProvider({
    url,
    name,
    token,
    document,
    // Reconnexions rapides : un minuteur de reprise en attente retiendrait jest.
    delay: 10,
    minDelay: 10,
    maxDelay: 50,
    onAuthenticated: (scope) => { etat.scope = scope; },
    onDenied: (raison) => { etat.refus = raison; },
    onLimitExceeded: (raison) => { etat.limite = raison; }
  });
  await attendre(() => provider.isSynced || etat.refus);
  return { provider, document, etat, texte: () => document.getText('t').toString() };
}

module.exports = { demarrerServeur, attendre, pause, client, JETONS };
