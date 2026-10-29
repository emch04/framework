/**
 * `@astratra/centrale/gouvernance` : le client léger des routes « Gouvernance » du tableau de bord.
 * Une app dont l'IA propose des actions sur ses données y envoie les propositions (aperçu compris), y lit les
 * règles d'autonomie et la confiance (clés publiques à épingler), y reprend les validations signées par une
 * personne, et y dit ce qu'elle en a fait. Le tableau de bord ne touche jamais aux données : c'est l'app qui
 * revérifie et exécute (par exemple avec `@astratra/gouvernance`, que ce paquet n'importe pas).
 *
 * - Authentification : le jeton de projet, en `Authorization: Bearer …`.
 * - Règles : gardées en mémoire avec leur ETag ; un 304 rend la copie.
 * - Sans dépendance, sans autre paquet Astratra ; `fetch` par défaut (Node 18+, navigateurs, React Native).
 *
 * Routes : GET /v1/gouvernance/rules · GET /v1/gouvernance/trust · POST /v1/gouvernance/proposals
 *          POST /v1/gouvernance/proposals/:id/status · GET /v1/gouvernance/validations?after=
 *          POST /v1/gouvernance/validations/:id/ack
 */

export const SCHEMA_REGLES_GOUVERNANCE = 'gouvernance-regles/1';
export const SCHEMA_CONFIANCE_GOUVERNANCE = 'gouvernance-confiance/1';

/** Les règles d'autonomie réglées dans le tableau de bord (forme lue par `remoteRules` d'une gouvernance). */
export interface ReglesGouvernance {
  schema: typeof SCHEMA_REGLES_GOUVERNANCE;
  version: number;
  rules: Array<Record<string, unknown>>;
  updatedAt: string | null;
}

/** Ce qu'il faut épingler dans l'app (option `trust` d'une gouvernance) : clés publiques seulement. */
export interface ConfianceGouvernance {
  schema: typeof SCHEMA_CONFIANCE_GOUVERNANCE;
  keys: Array<{ keyId: string; publicKey: string; notAfter?: string }>;
  approvers: Array<{ id: string; credentials: Array<{ id: string; publicKey: string }> }>;
  rpId: string;
  origins: string[];
}

/** Une validation signée, telle que le tableau de bord la rend. */
export interface ValidationRecue {
  id: string;
  sequence: number;
  propositionId: string;
  decision: 'approve' | 'decline' | 'undo';
  validation: Record<string, unknown>;
  acknowledged: boolean;
}

/** Ce que le client lit d'une vue de proposition (retour de `propose`, `applyValidation`, `undo`…). */
export interface VueProposition {
  status?: string | null;
  code?: string | null;
  proposal?: { id?: unknown; digest?: unknown } & Record<string, unknown> | null;
  explanation?: string | null;
  result?: { rowsAffected?: unknown } | null;
}

/** Ce qu'il faut pour appliquer une validation (une gouvernance de `@astratra/gouvernance` convient). */
export interface Gouvernance {
  applyValidation(validation: Record<string, unknown>, options: { organisationId: string }): Promise<VueProposition>;
}

export interface OptionsGouvernance {
  /** Adresse du tableau de bord. */
  adresse: string;
  /** Jeton de projet. */
  jeton: string;
  /** `fetch` à utiliser (tests, environnement sans fetch global). */
  fetch?: typeof globalThis.fetch;
  /** Délai maximal d'une requête (10 s par défaut). */
  delaiMs?: number;
}

/** Une erreur du tableau de bord (`code` vient de sa réponse) ou du réseau (`statut` null, code `reseau`). */
export class ErreurGouvernance extends Error {
  statut: number | null;
  code: string;
  constructor(statut: number | null, code: string, message?: string) {
    super(message ?? code);
    this.name = 'ErreurGouvernance';
    this.statut = statut;
    this.code = code;
  }
}

const IDENTIFIANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ETATS = ['ready', 'awaiting_validation', 'executing', 'executed', 'declined', 'expired', 'refused', 'stale', 'failed', 'undoing', 'undone'];

/** Réduit une vue à ce que le tableau de bord accepte comme état : un état connu, un code court, un nombre de lignes. */
export function etatDe(vue: VueProposition, { sansEtat = false } = {}): { status: string | null; code: string | null; rowsAffected: number } {
  const code = typeof vue?.code === 'string' && CODE.test(vue.code) ? vue.code : null;
  /* Une validation pour une proposition que l'app ne connaît pas (not_found) s'accuse aussi, avec son code. */
  const sans = sansEtat && vue && vue.status === null && code !== null;
  if (!vue || (!sans && (typeof vue.status !== 'string' || !ETATS.includes(vue.status)))) throw new ErreurGouvernance(null, 'etat_invalide');
  const lignes = Number(vue.result?.rowsAffected ?? 0);
  return {
    status: sans ? null : vue.status as string,
    code,
    rowsAffected: Number.isSafeInteger(lignes) && lignes >= 0 ? lignes : 0
  };
}

export interface GouvernanceCentrale {
  /** Les règles en vigueur (copie gardée si rien n'a changé, ETag). À passer en `remoteRules`. */
  lireRegles(): Promise<{ version: number; rules: Array<Record<string, unknown>> }>;
  /** Les clés publiques du service de validation et des approbateurs, à ÉPINGLER dans la configuration de l'app. */
  lireConfiance(): Promise<ConfianceGouvernance>;
  /** Envoie une proposition (forme canonique, empreinte comprise) et son état ; rejouable sans doublon. */
  envoyerProposition(vue: VueProposition): Promise<{ id: string; state: string }>;
  /** Dit au tableau de bord où en est une proposition (exécutée, annulée, données changées…). */
  signalerEtat(propositionId: string, vue: VueProposition): Promise<void>;
  /** Les validations signées pas encore accusées (`toutes` : accusées comprises, après le curseur gardé en mémoire). */
  lireValidations(options?: { toutes?: boolean }): Promise<ValidationRecue[]>;
  /** Accuse une validation avec ce que la gouvernance en a fait. */
  accuserValidation(id: string, vue: VueProposition): Promise<void>;
  /**
   * Un tour complet : lit les validations, les fait appliquer par la gouvernance, accuse chaque résultat. Une
   * validation dont l'application lève (base injoignable…) n'est pas accusée : elle revient au tour suivant.
   */
  synchroniser(gouvernance: Gouvernance, options: { organisationId: string }): Promise<Array<{ id: string; status: string | null; code: string | null }>>;
}

export function creerGouvernanceCentrale(options: OptionsGouvernance): GouvernanceCentrale {
  if (!options || typeof options.adresse !== 'string' || !/^https?:\/\//.test(options.adresse)) throw new ErreurGouvernance(null, 'adresse_invalide');
  if (typeof options.jeton !== 'string' || !options.jeton.trim()) throw new ErreurGouvernance(null, 'jeton_absent');
  const base = options.adresse.replace(/\/+$/, '');
  const delaiMs = options.delaiMs ?? 10_000;
  let regles: { etag: string; valeur: { version: number; rules: Array<Record<string, unknown>> } } | null = null;
  let curseur = 0;

  async function appeler(methode: 'GET' | 'POST', chemin: string, corps?: unknown, entetes: Record<string, string> = {}): Promise<Response> {
    const f = options.fetch ?? (globalThis as { fetch?: typeof globalThis.fetch }).fetch;
    if (typeof f !== 'function') throw new ErreurGouvernance(null, 'fetch_indisponible');
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(delaiMs) : undefined;
    let reponse: Response;
    try {
      reponse = await f(base + chemin, {
        method: methode, signal,
        headers: { Authorization: `Bearer ${options.jeton}`, Accept: 'application/json', ...(corps === undefined ? {} : { 'Content-Type': 'application/json' }), ...entetes },
        body: corps === undefined ? undefined : JSON.stringify(corps)
      });
    } catch {
      throw new ErreurGouvernance(null, 'reseau');
    }
    if (reponse.status >= 400) {
      let code = `http_${reponse.status}`;
      let message: string | undefined;
      try {
        const j = await reponse.json() as { error?: { code?: unknown; message?: unknown } };
        if (typeof j?.error?.code === 'string') code = j.error.code;
        if (typeof j?.error?.message === 'string') message = j.error.message;
      } catch { /* corps illisible : le code HTTP suffit */ }
      throw new ErreurGouvernance(reponse.status, code, message);
    }
    return reponse;
  }

  async function lireJson<T>(reponse: Response): Promise<T> {
    try { return await reponse.json() as T; } catch { throw new ErreurGouvernance(reponse.status, 'reponse_illisible'); }
  }
  async function vider(reponse: Response) {
    try { await reponse.body?.cancel(); } catch { /* sans importance */ }
  }
  const identifiant = (id: unknown) => {
    if (typeof id !== 'string' || !IDENTIFIANT.test(id)) throw new ErreurGouvernance(null, 'identifiant_invalide');
    return encodeURIComponent(id);
  };

  async function accuserValidation(id: string, vue: VueProposition) {
    await vider(await appeler('POST', `/v1/gouvernance/validations/${identifiant(id)}/ack`, etatDe(vue, { sansEtat: true })));
  }

  /*
   * Sans `toutes`, ce sont les validations pas encore accusées, depuis le début : une validation non accusée
   * revient au passage suivant. Avec `toutes`, un curseur gardé en mémoire avance.
   */
  async function lireValidations({ toutes = false } = {}): Promise<ValidationRecue[]> {
    const r = await appeler('GET', toutes ? `/v1/gouvernance/validations?after=${curseur}&include=all` : '/v1/gouvernance/validations');
    const j = await lireJson<{ validations?: ValidationRecue[]; next?: number }>(r);
    if (toutes && Number.isSafeInteger(j.next) && (j.next as number) >= curseur) curseur = j.next as number;
    return Array.isArray(j.validations) ? j.validations : [];
  }

  return {
    async lireRegles() {
      const r = await appeler('GET', '/v1/gouvernance/rules', undefined, regles ? { 'If-None-Match': regles.etag } : {});
      if (r.status === 304 && regles) { await vider(r); return regles.valeur; }
      const j = await lireJson<ReglesGouvernance>(r);
      if (!Number.isSafeInteger(j?.version) || !Array.isArray(j?.rules)) throw new ErreurGouvernance(r.status, 'reponse_illisible');
      const valeur = { version: j.version, rules: j.rules };
      const etag = r.headers.get('etag');
      regles = etag ? { etag, valeur } : null;
      return valeur;
    },

    async lireConfiance() {
      const j = await lireJson<ConfianceGouvernance>(await appeler('GET', '/v1/gouvernance/trust'));
      if (j?.schema !== SCHEMA_CONFIANCE_GOUVERNANCE || !Array.isArray(j.keys)) throw new ErreurGouvernance(null, 'reponse_illisible');
      return j;
    },

    async envoyerProposition(vue) {
      if (!vue?.proposal || typeof vue.proposal.digest !== 'string') throw new ErreurGouvernance(null, 'proposition_absente');
      identifiant(vue.proposal.id);
      const etat = etatDe(vue);
      const corps = { proposal: vue.proposal, explanation: typeof vue.explanation === 'string' ? vue.explanation.slice(0, 4000) : null, ...etat };
      return lireJson<{ id: string; state: string }>(await appeler('POST', '/v1/gouvernance/proposals', corps));
    },

    async signalerEtat(propositionId, vue) {
      await vider(await appeler('POST', `/v1/gouvernance/proposals/${identifiant(propositionId)}/status`, etatDe(vue)));
    },

    lireValidations,
    accuserValidation,

    async synchroniser(gouvernance, { organisationId }) {
      const faits: Array<{ id: string; status: string | null; code: string | null }> = [];
      for (const v of await lireValidations()) {
        let vue: VueProposition;
        try {
          vue = await gouvernance.applyValidation(v.validation, { organisationId });
        } catch {
          faits.push({ id: v.id, status: null, code: 'apply_failed' });
          continue;
        }
        try { await accuserValidation(v.id, vue); } catch (e) {
          /* Un résultat qu'on ne sait pas décrire ne s'accuse pas ; une panne du tableau de bord : la validation revient, et la gouvernance répondra « replayed ». */
          if (!(e instanceof ErreurGouvernance) || e.statut !== null || e.code !== 'etat_invalide') throw e;
        }
        faits.push({ id: v.id, status: vue?.status ?? null, code: vue?.code ?? null });
      }
      return faits;
    }
  };
}
