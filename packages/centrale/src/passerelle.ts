/**
 * `@astratra/centrale/passerelle` : le client de la passerelle des clés de Centrale. Une app n'y garde qu'un jeton de
 * projet (`clj_pas_…`, comme un DSN) : Centrale appelle les fournisseurs à sa place avec les clés de son coffre, compte
 * la consommation et le coût par projet, et une clé changée sert dès la requête suivante.
 *
 * - `lirePasserelle(env)` : l'adresse (`CENTRALE_ADRESSE`) et le jeton (`CENTRALE_PASSERELLE_JETON`), ou null ;
 * - `modeleDiscussion(p)` : un modèle au format OpenAI (adresse complète, adresse de base, clé, `auto`), à mettre EN
 *   TÊTE de la liste de relais d'une IA, ses clés directes restant derrière en secours ;
 * - `plongements`, `rechercher`, `voix` : les trois autres services.
 * Toute panne de la passerelle (injoignable, 5xx, 429, délai, service non configuré) lève `PasserelleIndisponible` :
 * l'appelant passe à ses clés directes. Une requête refusée pour elle-même (400, 413) lève `RequetePasserelleRefusee`.
 * Sans aucune dépendance (fetch de Node 18+). Aucun contenu n'est journalisé.
 */

export const NOM_JETON = 'CENTRALE_PASSERELLE_JETON';
export const NOM_ADRESSE = 'CENTRALE_ADRESSE';
const FORME_JETON = /^clj_pas_[A-Za-z0-9]{40}$/;

export interface Passerelle {
  /** Adresse de Centrale, sans barre finale. */
  adresse: string;
  jeton: string;
  /** Délai d'un appel (plongements, recherche, voix), en millisecondes. */
  delaiMs: number;
  fetch: typeof fetch;
}

/** La passerelle est en panne ou injoignable : passer aux clés directes. */
export class PasserelleIndisponible extends Error {
  readonly statut: number | null;
  constructor(statut: number | null, raison: string) {
    super(`Passerelle indisponible (${statut ?? 'sans réponse'}) : ${raison}`);
    this.name = 'PasserelleIndisponible';
    this.statut = statut;
  }
}

/** La passerelle a refusé la requête elle-même (trop grande, invalide) : les clés directes n'y changeraient rien. */
export class RequetePasserelleRefusee extends Error {
  readonly statut: number;
  constructor(statut: number, raison: string) {
    super(`Requête refusée par la passerelle (${statut}) : ${raison}`);
    this.name = 'RequetePasserelleRefusee';
    this.statut = statut;
  }
}

/**
 * La passerelle de l'environnement, ou null si elle n'est pas réglée (l'app garde alors ses clés directes).
 * Un jeton mal formé ou une adresse non HTTPS (hors boucle locale) ne branchent rien.
 */
export function lirePasserelle(
  env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {},
  options: { delaiMs?: number; fetch?: typeof fetch } = {}
): Passerelle | null {
  const jeton = (env[NOM_JETON] ?? '').trim();
  const brute = (env[NOM_ADRESSE] ?? '').trim();
  if (!FORME_JETON.test(jeton) || !brute) return null;
  let url: URL;
  try { url = new URL(brute); } catch { return null; }
  const locale = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && locale))) return null;
  const f = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== 'function') return null;
  return { adresse: url.toString().replace(/\/+$/, ''), jeton, delaiMs: options.delaiMs ?? 30_000, fetch: f };
}

/**
 * Le modèle de discussion de la passerelle, au format OpenAI : `auto` laisse Centrale choisir parmi les fournisseurs du projet.
 * `thoughtSignatures: true` : la passerelle relaie les signatures de pensée de Gemini 3 (`tool_calls[i].extra_content`) ;
 * un client qui les garde dans l'historique (`@astratra/ai` 1.12.0 et plus) les lui renvoie, sinon Gemini 3 refuse les tours d'outils.
 */
export function modeleDiscussion(p: Passerelle, modele = 'auto'): { url: string; baseUrl: string; apiKey: string; model: string; thoughtSignatures: true } {
  return { url: `${p.adresse}/v1/passerelle/ia/chat/completions`, baseUrl: `${p.adresse}/v1/passerelle/ia`, apiKey: p.jeton, model: modele, thoughtSignatures: true };
}

async function appeler(p: Passerelle, chemin: string, corps: unknown, signal?: AbortSignal): Promise<Response> {
  const delai = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(p.delaiMs) : undefined;
  const combine = signal && delai && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, delai]) : (signal ?? delai);
  let reponse: Response;
  try {
    reponse = await p.fetch(`${p.adresse}${chemin}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.jeton}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
      signal: combine
    });
  } catch (err) {
    // Annulée par l'appelant : on le lui rend tel quel.
    if (signal?.aborted) throw err;
    throw new PasserelleIndisponible(null, (err as Error)?.name === 'TimeoutError' ? 'délai dépassé' : 'injoignable');
  }
  if (reponse.ok) return reponse;
  let code = '';
  try { code = String(((await reponse.json()) as { error?: { code?: unknown } })?.error?.code ?? ''); } catch { /* corps illisible */ }
  if (reponse.status === 400 || reponse.status === 413) throw new RequetePasserelleRefusee(reponse.status, code || 'requête invalide');
  // 401/403 (jeton révoqué, périmètre absent), 429, 5xx, 503 (service non configuré) : les clés directes prennent le relais.
  throw new PasserelleIndisponible(reponse.status, code || 'refus');
}

/** Des vecteurs de sens (Gemini, 768 dimensions par défaut), dans l'ordre des textes. */
export async function plongements(p: Passerelle, textes: string[], options: { dimensions?: number; signal?: AbortSignal } = {}): Promise<number[][]> {
  const reponse = await appeler(p, '/v1/passerelle/ia/embeddings', { model: 'auto', input: textes, ...(options.dimensions ? { dimensions: options.dimensions } : {}) }, options.signal);
  const json = (await reponse.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
  const data = Array.isArray(json?.data) ? [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  if (data.length !== textes.length || data.some((d) => !Array.isArray(d.embedding))) throw new PasserelleIndisponible(reponse.status, 'réponse inattendue');
  return data.map((d) => d.embedding as number[]);
}

export interface ResultatRecherche {
  position: number; titre: string; url: string; extrait: string;
  /** La date de parution, quand Google la donne (« 2 sept. 2026 »). */
  date?: string;
  /** Les titres des sous-liens du résultat. */
  liens?: string[];
}

/** Une recherche récente : Google limité à la dernière heure, au jour, à la semaine, au mois ou à l'an. */
export type PeriodeRecherche = 'heure' | 'jour' | 'semaine' | 'mois' | 'an';

export interface ReponseRecherche {
  fournisseur: string;
  resultats: ResultatRecherche[];
  /** L'encadré de réponse de Google, s'il y en a un. */
  encadre?: { reponse: string; titre: string; url: string | null };
  /** La fiche de Google (Knowledge Graph), s'il y en a une. */
  fiche?: { titre: string; description: string; site: string | null };
  periode?: PeriodeRecherche;
}

/** Une recherche web (Serper, puis SerpApi en repli), résultats normalisés ; `periode` la limite aux résultats récents. */
export async function rechercher(
  p: Passerelle,
  demande: { requete: string; nombre?: number; langue?: string; pays?: string; periode?: PeriodeRecherche },
  options: { signal?: AbortSignal } = {}
): Promise<ReponseRecherche> {
  const reponse = await appeler(p, '/v1/passerelle/recherche', {
    requete: demande.requete, nombre: demande.nombre ?? 10, langue: demande.langue, pays: demande.pays, periode: demande.periode
  }, options.signal);
  const json = (await reponse.json()) as Partial<ReponseRecherche>;
  if (!Array.isArray(json?.resultats)) throw new PasserelleIndisponible(reponse.status, 'réponse inattendue');
  return {
    fournisseur: String(json.fournisseur ?? ''),
    resultats: json.resultats,
    ...(json.encadre ? { encadre: json.encadre } : {}),
    ...(json.fiche ? { fiche: json.fiche } : {}),
    ...(json.periode ? { periode: json.periode } : {})
  };
}

/** Une voix d'IA (Gemini) : l'audio (WAV par défaut, ou PCM) avec sa fréquence et ses canaux. */
export async function voix(
  p: Passerelle,
  demande: { texte: string; langue?: 'fr' | 'en'; format?: 'wav' | 'pcm'; voix?: string },
  options: { signal?: AbortSignal } = {}
): Promise<{ audio: Uint8Array; type: string; frequence: number; canaux: number }> {
  const reponse = await appeler(p, '/v1/passerelle/voix', { texte: demande.texte, langue: demande.langue ?? 'fr', format: demande.format ?? 'wav', ...(demande.voix ? { voix: demande.voix } : {}) }, options.signal);
  const audio = new Uint8Array(await reponse.arrayBuffer());
  if (!audio.length) throw new PasserelleIndisponible(reponse.status, 'audio vide');
  return {
    audio,
    type: reponse.headers.get('content-type') ?? 'audio/wav',
    frequence: Number(reponse.headers.get('x-audio-rate')) || 24_000,
    canaux: Number(reponse.headers.get('x-audio-channels')) || 1
  };
}

/**
 * La passerelle d'abord, les clés directes ensuite : `direct` n'est appelé que si la passerelle n'est pas réglée ou est
 * en panne (jamais pour une requête refusée pour elle-même). `surRepli` est prévenu de chaque repli (pour le signaler).
 */
export async function passerelleDabord<T>(
  p: Passerelle | null,
  viaPasserelle: (p: Passerelle) => Promise<T>,
  direct: () => Promise<T>,
  surRepli?: (erreur: PasserelleIndisponible) => void
): Promise<T> {
  if (!p) return direct();
  try {
    return await viaPasserelle(p);
  } catch (err) {
    if (!(err instanceof PasserelleIndisponible)) throw err;
    try { surRepli?.(err); } catch { /* jamais chez l'appelant */ }
    return direct();
  }
}
