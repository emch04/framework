/**
 * `@astratra/centrale/conscience` : le client léger des routes « Conscience » du tableau de bord.
 * Une IA y lit ses réglages (allumée, arrêt d'urgence, approbateurs, réflexion), y envoie son bilan du matin
 * et ses propositions en attente, et y reprend les décisions humaines (approuver, refuser) pour les soumettre
 * à son propre gouverneur. Le tableau de bord n'applique jamais rien.
 *
 * - Authentification : le jeton de projet, en `Authorization: Bearer …`.
 * - Réglages : gardés en mémoire avec leur ETag ; `If-None-Match` évite de les relire, un 304 rend la copie.
 * - Bilan : réduit ICI à des codes et des nombres (aucune question, réponse, note ni identité de personne) ;
 *   le tableau de bord vérifie à nouveau et refuse tout le reste.
 * - Sans dépendance, sans autre paquet Astratra ; `fetch` par défaut (Node 18+, navigateurs, React Native).
 *
 * Routes : GET /v1/conscience/settings · POST /v1/conscience/report · GET /v1/conscience/decisions?after=
 *          POST /v1/conscience/decisions/:id/ack
 */

import { masquerTexte } from './masquage.ts';

export const SCHEMA_BILAN_CONSCIENCE = 'conscience-report/1';

/** Les réglages tels que le tableau de bord les rend (forme lue par l'adaptateur de réglages distants d'un gouverneur). */
export interface ReglagesConscience {
  schema: 'conscience-settings/1';
  version: number;
  enabled: boolean;
  halted: boolean;
  haltedAt: string | null;
  /** La personne qui a levé l'arrêt d'urgence : seule elle relâche le gouverneur. */
  resumedBy: string | null;
  approvers: string[];
  reflection: { automatic: boolean; hour: number; timeZone: string };
  cyclesPerDay: number;
  updatedAt: string | null;
}

export interface DecisionConscience {
  id: string;
  sequence: number;
  proposalId: string;
  decision: 'approve' | 'decline';
  approver: { kind: 'human'; id: string };
  reasonCode: string | null;
  decidedAt: string;
  acknowledged: boolean;
}

export type ResultatDecision = 'applied' | 'already_applied' | 'refused';

/** Le format envoyé : des codes et des nombres seulement. */
export interface BilanConscience {
  schema: typeof SCHEMA_BILAN_CONSCIENCE;
  since: string;
  until: string;
  policyVersion: string;
  halted: boolean;
  counts: Record<string, number>;
  findings: Array<{ code: string; severity: string; subject: { kind: string; id: string }; sampleSize: number | null; confidence: number | null; metrics: Mesures | null }>;
  pending: Array<{
    id: string; target: { kind: string | null; id: string | null }; change: Mesures | null; justification: string | null; risk: string;
    requiredApprovals: number; approvalsValid: number; scopes: string[]; proposedBy: { kind: string; id: string | null } | null;
    createdAt: string; hasTests: boolean; hasRollbackPlan: boolean;
  }>;
}
export type Mesures = { [cle: string]: number | boolean | string | null | number[] | Mesures };

/** Ce que le client lit d'un bilan de gouverneur (`morningReport`). Tout le reste est ignoré. */
export interface RapportGouverneur {
  since: string | number | Date;
  until: string | number | Date;
  policyVersion?: string;
  halted?: boolean;
  counts?: Record<string, unknown>;
  findings?: { items?: Array<{ code?: unknown; severity?: unknown; subject?: { kind?: unknown; id?: unknown } | null; sampleSize?: unknown; confidence?: unknown; metrics?: unknown }> };
  pendingProposals?: Array<{
    id?: unknown; target?: { kind?: unknown; id?: unknown } | null; risk?: unknown; requiredApprovals?: unknown; approvalsValid?: unknown; scopes?: unknown;
    proposedBy?: { kind?: unknown; id?: unknown } | null; createdAt?: unknown; hasTests?: unknown; hasRollbackPlan?: unknown;
  }>;
}
/** Une proposition complète du gouverneur (`listProposals`), pour joindre son changement et sa justification s'ils sont des codes. */
export interface PropositionGouverneur { id: string; change?: unknown; justification?: unknown }

export interface OptionsConscience {
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
export class ErreurConscience extends Error {
  statut: number | null;
  code: string;
  constructor(statut: number | null, code: string, message?: string) {
    super(message ?? code);
    this.name = 'ErreurConscience';
    this.statut = statut;
    this.code = code;
  }
}

const CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const CLE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const IDENTIFIANT = /^[A-Za-z0-9_.:-]{1,128}$/;
const RISQUES = ['low', 'medium', 'high', 'critical'];
const GRAVITES = ['info', 'low', 'medium', 'high', 'critical'];
const ACTEURS = ['engine', 'model', 'human', 'system'];
const COMPTEURS = ['findings', 'pending', 'pendingHighRisk', 'approvedAwaitingStage', 'rollouts', 'rejections', 'humanRejections', 'rollbacks'];

/* Une chaîne passe si elle a la forme voulue et que le masquage ne la changerait pas (les longues suites hexadécimales d'un identifiant sont admises). */
function propre(v: unknown, forme: RegExp): v is string {
  if (typeof v !== 'string' || !forme.test(v)) return false;
  const sansHex = v.replace(/[a-f0-9]{32,}/gi, 'h');
  return masquerTexte(sansHex) === sansHex;
}
const code = (v: unknown): string | null => (propre(v, CODE) ? v : null);
const ident = (v: unknown): string | null => (propre(v, IDENTIFIANT) ? v : null);
const entier = (v: unknown, max = 1_000_000_000): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : null);
const iso = (v: unknown): string | null => {
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Garde des mesures ce qui est nombre, booléen, code ou petit tableau de nombres, sur deux niveaux ; le reste disparaît. */
export function nettoyerMesures(valeur: unknown, profondeur = 0): Mesures | null {
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) return null;
  const sortie: Mesures = {};
  for (const [k, v] of Object.entries(valeur).slice(0, 32)) {
    if (!CLE.test(k)) continue;
    if (v === null || typeof v === 'boolean') sortie[k] = v;
    else if (typeof v === 'number') { if (Number.isFinite(v)) sortie[k] = v; }
    else if (typeof v === 'string') { const c = code(v); if (c) sortie[k] = c; }
    else if (Array.isArray(v)) { if (v.length <= 20 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) sortie[k] = v as number[]; }
    else if (typeof v === 'object' && profondeur < 1) { const m = nettoyerMesures(v, profondeur + 1); if (m) sortie[k] = m; }
  }
  return sortie;
}

/**
 * Réduit le bilan du matin d'un gouverneur au format envoyé : identifiants, codes et nombres. Les identifiants
 * de décisions, les preuves, les objets `tests` et plans de retour arrière, le propriétaire d'une proposition et
 * l'identité d'une personne qui propose ne partent jamais. `propositions` (facultatif) joint le changement et la
 * justification d'une proposition en attente quand ils ne sont faits que de codes.
 */
export function resumerBilan(rapport: RapportGouverneur, propositions: PropositionGouverneur[] = []): BilanConscience {
  const parId = new Map(propositions.filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
  const counts: Record<string, number> = {};
  for (const k of COMPTEURS) { const n = entier(rapport.counts?.[k]); if (n !== null) counts[k] = n; }
  const findings: BilanConscience['findings'] = [];
  for (const f of rapport.findings?.items ?? []) {
    const c = code(f?.code); const kind = code(f?.subject?.kind); const id = ident(f?.subject?.id);
    if (!c || !kind || !id || !GRAVITES.includes(f.severity as string)) continue;
    const confiance = typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1 ? f.confidence : null;
    findings.push({ code: c, severity: f.severity as string, subject: { kind, id }, sampleSize: entier(f.sampleSize), confidence: confiance, metrics: nettoyerMesures(f.metrics) });
    if (findings.length >= 200) break;
  }
  const pending: BilanConscience['pending'] = [];
  for (const p of rapport.pendingProposals ?? []) {
    const id = ident(p?.id); const cree = iso(p?.createdAt);
    if (!id || !cree || !RISQUES.includes(p.risk as string)) continue;
    const complete = parId.get(id);
    const acteur = p.proposedBy && ACTEURS.includes(p.proposedBy.kind as string)
      ? { kind: p.proposedBy.kind as string, id: p.proposedBy.kind === 'human' ? null : ident(p.proposedBy.id) } : null;
    pending.push({
      id, target: { kind: code(p.target?.kind), id: ident(p.target?.id) },
      change: complete ? nettoyerMesures(complete.change) : null, justification: complete ? code(complete.justification) : null,
      risk: p.risk as string, requiredApprovals: entier(p.requiredApprovals, 10) ?? 1, approvalsValid: entier(p.approvalsValid, 10) ?? 0,
      scopes: (Array.isArray(p.scopes) ? p.scopes : []).map(code).filter((s): s is string => s !== null).slice(0, 20),
      proposedBy: acteur, createdAt: cree, hasTests: p.hasTests === true, hasRollbackPlan: p.hasRollbackPlan === true
    });
    if (pending.length >= 200) break;
  }
  const maintenant = new Date().toISOString();
  return {
    schema: SCHEMA_BILAN_CONSCIENCE, since: iso(rapport.since) ?? maintenant, until: iso(rapport.until) ?? maintenant,
    policyVersion: ident(rapport.policyVersion) ?? 'unknown', halted: rapport.halted === true, counts, findings, pending
  };
}

export interface ConscienceCentrale {
  /** Les réglages en vigueur (copie gardée si rien n'a changé, ETag). Lève ErreurConscience si le tableau de bord ne répond pas. */
  lireReglages(): Promise<ReglagesConscience>;
  /** Envoie le bilan du matin et la liste complète des propositions en attente (réduits par `resumerBilan`). */
  envoyerBilan(rapport: RapportGouverneur, propositions?: PropositionGouverneur[]): Promise<{ received: { findings: number; pending: number } }>;
  /** Les décisions humaines pas encore accusées, après le curseur gardé en mémoire (`toutes` : accusées comprises). */
  lireDecisions(options?: { toutes?: boolean }): Promise<DecisionConscience[]>;
  /** Dit au tableau de bord ce que le gouverneur a fait d'une décision. */
  accuserDecision(id: string, resultat: { result: ResultatDecision; code?: string | null }): Promise<void>;
  /** Accuse une liste de résultats ; ceux en `failed` (gouverneur injoignable) ne sont pas accusés, pour revenir au prochain passage. */
  accuserDecisions(resultats: Array<{ id: string | null; result: string; code?: string | null }>): Promise<number>;
}

export function creerConscienceCentrale(options: OptionsConscience): ConscienceCentrale {
  if (!options || typeof options.adresse !== 'string' || !/^https?:\/\//.test(options.adresse)) throw new ErreurConscience(null, 'adresse_invalide');
  if (typeof options.jeton !== 'string' || !options.jeton.trim()) throw new ErreurConscience(null, 'jeton_absent');
  const base = options.adresse.replace(/\/+$/, '');
  const delaiMs = options.delaiMs ?? 10_000;
  let reglages: { etag: string; valeur: ReglagesConscience } | null = null;
  let curseur = 0;

  async function appeler(methode: 'GET' | 'POST', chemin: string, corps?: unknown, entetes: Record<string, string> = {}): Promise<Response> {
    const f = options.fetch ?? (globalThis as { fetch?: typeof globalThis.fetch }).fetch;
    if (typeof f !== 'function') throw new ErreurConscience(null, 'fetch_indisponible');
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(delaiMs) : undefined;
    let reponse: Response;
    try {
      reponse = await f(base + chemin, {
        method: methode, signal,
        headers: { Authorization: `Bearer ${options.jeton}`, Accept: 'application/json', ...(corps === undefined ? {} : { 'Content-Type': 'application/json' }), ...entetes },
        body: corps === undefined ? undefined : JSON.stringify(corps)
      });
    } catch {
      throw new ErreurConscience(null, 'reseau');
    }
    if (reponse.status >= 400) {
      let code = `http_${reponse.status}`;
      let message: string | undefined;
      try {
        const j = await reponse.json() as { error?: { code?: unknown; message?: unknown } };
        if (typeof j?.error?.code === 'string') code = j.error.code;
        if (typeof j?.error?.message === 'string') message = j.error.message;
      } catch { /* corps illisible : le code HTTP suffit */ }
      throw new ErreurConscience(reponse.status, code, message);
    }
    return reponse;
  }

  async function accuserDecision(id: string, { result, code = null }: { result: ResultatDecision; code?: string | null }): Promise<void> {
    const r = await appeler('POST', `/v1/conscience/decisions/${encodeURIComponent(id)}/ack`, { result, code });
    try { await r.body?.cancel(); } catch { /* sans importance */ }
  }

  async function lireJson<T>(reponse: Response): Promise<T> {
    try { return await reponse.json() as T; } catch { throw new ErreurConscience(reponse.status, 'reponse_illisible'); }
  }

  return {
    async lireReglages() {
      const r = await appeler('GET', '/v1/conscience/settings', undefined, reglages ? { 'If-None-Match': reglages.etag } : {});
      if (r.status === 304 && reglages) { try { await r.body?.cancel(); } catch { /* sans importance */ } return reglages.valeur; }
      const valeur = await lireJson<ReglagesConscience>(r);
      const etag = r.headers.get('etag');
      reglages = etag ? { etag, valeur } : null;
      return valeur;
    },

    async envoyerBilan(rapport, propositions = []) {
      const r = await appeler('POST', '/v1/conscience/report', resumerBilan(rapport, propositions));
      return lireJson(r);
    },

    /*
     * Sans `toutes`, ce sont les décisions pas encore accusées, depuis le début : une décision non accusée
     * (gouverneur injoignable) revient au passage suivant. Avec `toutes`, un curseur gardé en mémoire avance.
     */
    async lireDecisions({ toutes = false } = {}) {
      const r = await appeler('GET', toutes ? `/v1/conscience/decisions?after=${curseur}&include=all` : '/v1/conscience/decisions');
      const j = await lireJson<{ decisions?: DecisionConscience[]; next?: number }>(r);
      if (toutes && Number.isSafeInteger(j.next) && (j.next as number) >= curseur) curseur = j.next as number;
      return Array.isArray(j.decisions) ? j.decisions : [];
    },

    accuserDecision,

    async accuserDecisions(resultats) {
      let n = 0;
      for (const x of resultats) {
        if (!x.id || !['applied', 'already_applied', 'refused'].includes(x.result)) continue;
        const c = typeof x.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x.code) ? x.code : null;
        await accuserDecision(x.id, { result: x.result as ResultatDecision, code: c });
        n++;
      }
      return n;
    }
  };
}
