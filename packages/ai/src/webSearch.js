/**
 * Une recherche web pour un agent, au format Serper (résultats Google).
 *
 * Ce qui revient au modèle est tenu court et propre : des résultats https
 * seulement, un titre obligatoire, au plus `num`, et un filtre de l'appelant
 * (un site hostile, une source refusée) appliqué AVANT que le modèle ne lise.
 * La clé part dans l'en-tête et n'apparaît dans aucune erreur.
 */

const DEFAULT_ENDPOINT = 'https://google.serper.dev/search';
const DEFAULT_NUM = 8;
const DEFAULT_TIMEOUT_MS = 10_000;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {object} search
 * @param {string} search.query
 * @param {string[]} [search.sites]  la recherche restreinte à ces sites (site:a OR site:b).
 * @param {string} [search.hl]       la langue de l'interface de recherche.
 * @param {number} [search.num]      Défaut 8.
 * @param {object} io
 * @param {string} io.key
 * @param {Function} io.fetch
 * @param {Function} [io.accept]     ({ title, url, snippet, date }, URL) => boolean — false : le résultat est écarté.
 * @param {number} [io.timeoutMs]    Défaut 10 s.
 * @param {string} [io.endpoint]
 * @returns {Promise<{ title: string, url: string, snippet: string, date: string|null }[]>}
 * @throws {Error} code 'WEB_SEARCH_NO_KEY' sans clé (rien n'est demandé), 'WEB_SEARCH_FAILED' sinon.
 */
async function searchSerper(search = {}, io = {}) {
  if (!io.key) throw failure('WEB_SEARCH_NO_KEY', 'no key');
  if (typeof io.fetch !== 'function') throw new Error('searchSerper requires io.fetch.');
  const num = search.num || DEFAULT_NUM;
  const scope = (search.sites || []).map((site) => `site:${site}`).join(' OR ');
  let answer;
  try {
    const response = await io.fetch(io.endpoint || DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-KEY': io.key, 'content-type': 'application/json' },
      body: JSON.stringify({ q: scope ? `${search.query} ${scope}` : search.query, num, ...(search.hl ? { hl: search.hl } : {}) }),
      signal: globalThis.AbortSignal.timeout(io.timeoutMs || DEFAULT_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Serper answered ${response.status}`);
    answer = await response.json();
  } catch (error) {
    throw failure('WEB_SEARCH_FAILED', error.message);
  }
  const accept = typeof io.accept === 'function' ? io.accept : () => true;
  return (Array.isArray(answer?.organic) ? answer.organic : [])
    .flatMap((result) => {
      let url;
      try {
        url = new URL(String(result?.link));
      } catch (_error) {
        return [];
      }
      const title = typeof result.title === 'string' ? result.title.trim() : '';
      const snippet = typeof result.snippet === 'string' ? result.snippet.trim() : '';
      if (url.protocol !== 'https:' || !title) return [];
      const found = { title, url: url.href, snippet, date: typeof result.date === 'string' ? result.date : null };
      return accept(found, url) ? [found] : [];
    })
    .slice(0, num);
}

module.exports = { searchSerper };
