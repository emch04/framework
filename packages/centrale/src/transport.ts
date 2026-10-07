/**
 * Le transport : ce qui pousse un envoi vers le backend. Injecté dans `creerCentrale`
 * pour les tests ; par défaut, `fetch` (Node 18+, navigateurs, React Native).
 */

/** Une requête prête à partir : adresse complète, en-têtes et corps JSON déjà sérialisé. */
export interface RequeteTransport {
  url: string;
  entetes: Record<string, string>;
  corps: string;
}

/** Ce que le cœur a besoin de savoir de la réponse. */
export interface ReponseTransport {
  statut: number;
  /** Valeur brute de l'en-tête `Retry-After` (secondes ou date HTTP), s'il y en a une. */
  reessayerApres?: string | null;
}

/** Peut lever ou rejeter (hors ligne, délai dépassé) : le cœur l'attrape et réessaie plus tard. */
export type Transport = (requete: RequeteTransport) => Promise<ReponseTransport>;

/** Transport par défaut, avec un délai maximal pour ne jamais rester bloqué. */
export function transportFetch(delaiMs = 10_000): Transport {
  return async (requete) => {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f !== 'function') throw new Error('fetch indisponible');
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(delaiMs)
      : undefined;
    const reponse = await f(requete.url, { method: 'POST', headers: requete.entetes, body: requete.corps, signal, keepalive: requete.corps.length < 60_000 });
    // Le corps n'est pas lu : on le jette pour libérer la connexion.
    try { await reponse.body?.cancel(); } catch { /* sans importance */ }
    return { statut: reponse.status, reessayerApres: reponse.headers.get('retry-after') };
  };
}

/** Délai en millisecondes demandé par `Retry-After` (secondes ou date HTTP), ou null s'il est illisible. */
export function lireRetryAfter(valeur: string | null | undefined, maintenant: number): number | null {
  if (!valeur) return null;
  const texte = valeur.trim();
  if (/^\d+(\.\d+)?$/.test(texte)) return Math.round(Number(texte) * 1000);
  const date = Date.parse(texte);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - maintenant);
}
