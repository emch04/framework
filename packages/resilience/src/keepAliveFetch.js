/**
 * Un fetch qui garde ses connexions ouvertes : Node referme une connexion après 4 s sans activité, si bien que chaque
 * appel espacé (une voix d'IA lue, une question) refait la poignée de main TLS avec le fournisseur. Ici elles restent
 * ouvertes `keepAliveMs` (4 min par défaut).
 *
 * Une connexion gardée peut avoir été fermée par l'autre côté juste avant l'envoi : la demande échoue alors sur le
 * réseau sans avoir été lue. Elle est refaite une fois, sur une connexion neuve (jamais pour un corps en flux, qui ne
 * se relit pas, ni pour une demande annulée).
 *
 * Rien n'est gardé ni journalisé du contenu. `close()` libère les connexions (arrêt du service, tests).
 */

const STALE_CODES = new Set(['UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNRESET', 'EPIPE']);

function isStaleConnection(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (STALE_CODES.has(current.code)) return true;
  }
  return false;
}

function replayable(init) {
  const body = init && init.body;
  return body === undefined || body === null || typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer;
}

/**
 * @param {object} [options]
 * @param {number} [options.keepAliveMs=240000] durée de vie d'une connexion inactive.
 * @param {number} [options.connections=16] connexions au plus par adresse.
 * @param {object} [options.undici] le module undici (injecté en test) ; sinon `require('undici')`.
 * @returns {Function & { close(): Promise<void> }}
 */
function createKeepAliveFetch(options = {}) {
  const undici = options.undici || require('undici');
  const keepAliveMs = options.keepAliveMs === undefined ? 240_000 : options.keepAliveMs;
  if (!Number.isFinite(keepAliveMs) || keepAliveMs < 1000) throw new TypeError('keepAliveMs must be at least 1000.');
  const agent = new undici.Agent({ keepAliveTimeout: keepAliveMs, keepAliveMaxTimeout: keepAliveMs, connections: options.connections || 16 });
  const send = options.fetch || undici.fetch;

  async function keepAliveFetch(url, init = {}) {
    try {
      return await send(url, { ...init, dispatcher: agent });
    } catch (error) {
      if (!isStaleConnection(error) || (init.signal && init.signal.aborted) || !replayable(init)) throw error;
      return send(url, { ...init, dispatcher: agent });
    }
  }
  keepAliveFetch.close = () => agent.close();
  return keepAliveFetch;
}

module.exports = { createKeepAliveFetch, isStaleConnection };
