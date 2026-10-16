/**
 * `@astratra/centrale/agents` : le journal des agents. Une IA y envoie chacune de ses exécutions
 * (tours de modèle, outils appelés, jetons, durée, coût, statut, actions proposées) au tableau de bord.
 *
 * Requête : POST {adresse}/v1/agents, en-tête `X-Centrale-Cle` (la clé PUBLIQUE du projet), corps JSON
 * `{ "executions": [...] }`, au plus 100 exécutions par lot. Réponses : 202 { recus }, 400 format refusé,
 * 401 clé inconnue ou révoquée, 413 trop gros, 429 trop d'envois (`Retry-After`).
 *
 * - `construireExecution(bilan)` : une exécution SANS contenu. Ni question, ni réponse, ni arguments, ni
 *   résultats d'outils, ni message d'erreur (un code court). Une option explicite, désactivée par défaut,
 *   permet de les joindre ; ils sont alors masqués avant l'envoi.
 * - `creerJournalAgents({ adresse, cle })` : valide en local (clé inconnue refusée, bornes du format, dates à la
 *   seconde), masque, met en file en mémoire et envoie. Un échec réseau, un 5xx ou un 429 remet le lot en file
 *   avec un recul progressif ; un refus 4xx abandonne le lot en silence. Ne lève jamais.
 * - Sans dépendance ; `fetch` par défaut (Node 18+).
 */

import { masquerTexte } from './masquage.ts';
import { lireRetryAfter, transportFetch } from './transport.ts';
import type { Transport } from './transport.ts';
import { TAILLE_MAX_ENVOI } from './envoi.ts';

export const EXECUTIONS_MAX_PAR_LOT = 100;
export const ETAPES_MAX = 500;
export const SOURCES_MAX = 100;
export const ACTIONS_MAX = 100;
export const TEXTE_MAX = 8000;
export const ERREUR_MAX = 2000;
export const FILE_AGENTS_MAX = 1000;
export const RECUL_AGENTS_BASE_MS = 2_000;
export const RECUL_AGENTS_MAX_MS = 5 * 60_000;

export const STATUTS_AGENTS = ['ok', 'erreur', 'interrompue', 'en_attente_confirmation'] as const;
export const TYPES_ETAPES = ['tour_modele', 'appel_outil', 'resume_contexte', 'plan_mis_a_jour', 'verification_but'] as const;
export const ETATS_ACTIONS = ['proposee', 'confirmee', 'refusee', 'annulee', 'executee'] as const;

export type StatutAgent = typeof STATUTS_AGENTS[number];
export type TypeEtape = typeof TYPES_ETAPES[number];
export type EtatAction = typeof ETATS_ACTIONS[number];

export interface EtapeAgent {
  type: TypeEtape;
  outil?: string;
  dureeMs?: number;
  succes?: boolean;
  codeErreur?: string;
  modele?: string;
  jetonsEntree?: number;
  jetonsSortie?: number;
  arguments?: string;
  resultat?: string;
}
export interface SourceAgent { titre: string; url?: string; reference?: string; extrait?: string }
export interface ActionAgent {
  outil: string;
  etat: EtatAction;
  proposeeLe: string;
  confirmeeLe?: string;
  refuseeLe?: string;
  annuleeLe?: string;
  executeeLe?: string;
}
/** Une exécution telle que la reçoit le tableau de bord. */
export interface ExecutionAgent {
  identifiantExterne: string;
  environnement: string;
  agent: string;
  mode: string;
  /** Identifiant opaque ; le tableau de bord n'en garde que l'empreinte SHA-256. */
  utilisateur?: string;
  question?: string;
  reponse?: string;
  statut: StatutAgent;
  erreur?: string;
  modeles: string[];
  tours: number;
  dureeMs: number;
  jetonsEntree: number;
  jetonsSortie: number;
  coutEstime: number;
  debut: string;
  fin?: string;
  etapes: EtapeAgent[];
  sources: SourceAgent[];
  actions: ActionAgent[];
}

type Instant = Date | string | number;

/** Un tour de modèle (un appel au modèle). */
export interface TourModele {
  modele: string;
  dureeMs?: number;
  jetonsEntree?: number;
  jetonsSortie?: number;
  /** Faux si l'appel a échoué. Vrai par défaut. */
  succes?: boolean;
  /** Un code court (« http_500 »), jamais un message. */
  codeErreur?: string;
  /** Le coût de ce tour, si l'appelant le compte tour par tour. */
  cout?: number;
}
/** Un outil appelé. `arguments` et `resultat` ne partent qu'avec `inclureContenu`. */
export interface OutilAppele {
  outil: string;
  succes: boolean;
  dureeMs?: number;
  codeErreur?: string;
  arguments?: unknown;
  resultat?: unknown;
}
/** Une action (outil d'écriture) proposée, avec son état. Les dates manquantes sont déduites de l'état. */
export interface ActionProposee {
  outil: string;
  etat: EtatAction;
  proposeeLe?: Instant;
  confirmeeLe?: Instant;
  refuseeLe?: Instant;
  annuleeLe?: Instant;
  executeeLe?: Instant;
}

export interface BilanAgent {
  /** Unique par projet : un renvoi met à jour l'exécution, sans doublon. */
  identifiant: string;
  agent: string;
  /** « discussion », le nom d'une tâche… */
  mode: string;
  environnement?: string;
  /** Identifiant opaque (jamais un nom ni un e-mail). */
  utilisateur?: string;
  debut: Instant;
  fin: Instant;
  statut: StatutAgent;
  /** Un code court, jamais un message. */
  codeErreur?: string;
  tours?: TourModele[];
  outils?: OutilAppele[];
  actions?: ActionProposee[];
  /** Remplace la somme des jetons des tours. */
  jetonsEntree?: number;
  jetonsSortie?: number;
  /** Remplace la somme des coûts des tours. */
  coutEstime?: number;
  question?: string;
  reponse?: string;
}

export interface OptionsConstruction {
  /** Joint question, réponse, arguments et résultats des outils (masqués). Désactivé par défaut. */
  inclureContenu?: boolean;
}

const CODE_ERREUR = /^[a-z][a-z0-9_.:-]{0,63}$/i;

function entierPositif(v: unknown, max = 1e12): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), max) : 0;
}
function codeCourt(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  return CODE_ERREUR.test(v) ? v : 'erreur';
}
function texteContenu(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return t.slice(0, TEXTE_MAX);
}
/** Une date au format du journal : ISO à la seconde, en UTC. Null si illisible. */
export function dateJournal(v: unknown): string | null {
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(Math.floor(t / 1000) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Construit l'exécution à envoyer. Fonction pure. Sans `inclureContenu`, ni question, ni réponse, ni arguments,
 * ni résultats ne sont repris, même si le bilan les porte ; l'erreur est un code court.
 */
export function construireExecution(bilan: BilanAgent, options: OptionsConstruction = {}): ExecutionAgent {
  const tours = bilan.tours ?? [];
  const outils = bilan.outils ?? [];
  const debut = dateJournal(bilan.debut) ?? dateJournal(new Date()) as string;
  let fin = dateJournal(bilan.fin) ?? debut;
  if (fin < debut) fin = debut;
  const etapes: EtapeAgent[] = [
    ...tours.map((t): EtapeAgent => {
      const reussi = t.succes !== false;
      const code = reussi ? undefined : (codeCourt(t.codeErreur) ?? 'erreur');
      return {
        type: 'tour_modele', modele: String(t.modele), succes: reussi, ...(code ? { codeErreur: code } : {}),
        ...(t.dureeMs !== undefined ? { dureeMs: entierPositif(t.dureeMs) } : {}),
        jetonsEntree: entierPositif(t.jetonsEntree), jetonsSortie: entierPositif(t.jetonsSortie)
      };
    }),
    ...outils.map((o): EtapeAgent => {
      const code = o.succes ? undefined : (codeCourt(o.codeErreur) ?? 'erreur');
      const args = options.inclureContenu ? texteContenu(o.arguments) : undefined;
      const res = options.inclureContenu ? texteContenu(o.resultat) : undefined;
      return {
        type: 'appel_outil', outil: String(o.outil), succes: o.succes === true, ...(code ? { codeErreur: code } : {}),
        ...(o.dureeMs !== undefined ? { dureeMs: entierPositif(o.dureeMs) } : {}),
        ...(args !== undefined ? { arguments: args } : {}), ...(res !== undefined ? { resultat: res } : {})
      };
    })
  ];
  const actions: ActionAgent[] = (bilan.actions ?? []).map((a) => {
    const proposee = dateJournal(a.proposeeLe) ?? debut;
    const date = (v: Instant | undefined, defaut: string): string => {
      const d = dateJournal(v) ?? defaut;
      return d < proposee ? proposee : d;
    };
    const action: ActionAgent = { outil: String(a.outil), etat: a.etat, proposeeLe: proposee };
    if (a.etat === 'confirmee' || a.confirmeeLe !== undefined) action.confirmeeLe = date(a.confirmeeLe, fin);
    if (a.etat === 'refusee' || a.refuseeLe !== undefined) action.refuseeLe = date(a.refuseeLe, fin);
    if (a.etat === 'annulee' || a.annuleeLe !== undefined) action.annuleeLe = date(a.annuleeLe, fin);
    if (a.etat === 'executee' || a.executeeLe !== undefined) action.executeeLe = date(a.executeeLe, fin);
    return action;
  });
  const somme = (cle: 'jetonsEntree' | 'jetonsSortie'): number => tours.reduce((s, t) => s + entierPositif(t[cle]), 0);
  const cout = typeof bilan.coutEstime === 'number' && Number.isFinite(bilan.coutEstime) && bilan.coutEstime >= 0
    ? bilan.coutEstime
    : tours.reduce((s, t) => s + (typeof t.cout === 'number' && Number.isFinite(t.cout) && t.cout > 0 ? t.cout : 0), 0);
  const execution: ExecutionAgent = {
    identifiantExterne: bilan.identifiant,
    environnement: bilan.environnement ?? 'production',
    agent: bilan.agent,
    mode: bilan.mode,
    ...(bilan.utilisateur ? { utilisateur: String(bilan.utilisateur) } : {}),
    statut: bilan.statut,
    ...(bilan.statut === 'erreur' || bilan.codeErreur ? { erreur: codeCourt(bilan.codeErreur) ?? 'erreur' } : {}),
    modeles: [...new Set(tours.map((t) => String(t.modele)))],
    tours: tours.length,
    dureeMs: Math.max(0, Date.parse(fin) - Date.parse(debut)),
    jetonsEntree: bilan.jetonsEntree !== undefined ? entierPositif(bilan.jetonsEntree) : somme('jetonsEntree'),
    jetonsSortie: bilan.jetonsSortie !== undefined ? entierPositif(bilan.jetonsSortie) : somme('jetonsSortie'),
    coutEstime: Math.round(cout * 1e6) / 1e6,
    debut, fin,
    etapes, sources: [], actions
  };
  if (options.inclureContenu) {
    const q = texteContenu(bilan.question); const r = texteContenu(bilan.reponse);
    if (q !== undefined) execution.question = q;
    if (r !== undefined) execution.reponse = r;
  }
  return execution;
}

// ——— Validation locale ———

const CLES_EXECUTION = new Set(['identifiantExterne', 'environnement', 'agent', 'mode', 'utilisateur', 'question', 'reponse', 'statut', 'erreur',
  'modeles', 'tours', 'dureeMs', 'jetonsEntree', 'jetonsSortie', 'coutEstime', 'debut', 'fin', 'etapes', 'sources', 'actions']);
const CLES_ETAPE = new Set(['type', 'outil', 'dureeMs', 'succes', 'codeErreur', 'modele', 'jetonsEntree', 'jetonsSortie', 'arguments', 'resultat']);
const CLES_SOURCE = new Set(['titre', 'url', 'reference', 'extrait']);
const CLES_ACTION = new Set(['outil', 'etat', 'proposeeLe', 'confirmeeLe', 'refuseeLe', 'annuleeLe', 'executeeLe']);

function inconnues(o: object, permises: Set<string>): string | null {
  for (const k of Object.keys(o)) if (!permises.has(k)) return k;
  return null;
}
const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const mot = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v : null);
const nombre = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function adresseSansSecret(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    u.search = ''; u.hash = '';
    return u.toString();
  } catch { return null; }
}

export type ResultatValidation = { ok: true; execution: ExecutionAgent } | { ok: false; raison: string };

/**
 * Vérifie une exécution avant l'envoi : une clé inconnue, un statut, un type ou un état hors liste, une étape
 * ou une action mal formée la REFUSENT ; les listes trop longues sont coupées aux bornes du format, les textes
 * tronqués puis masqués, les dates ramenées à la seconde.
 */
export function validerExecution(brute: unknown): ResultatValidation {
  if (!estObjet(brute)) return { ok: false, raison: 'exécution illisible' };
  const inconnue = inconnues(brute, CLES_EXECUTION);
  if (inconnue) return { ok: false, raison: `clé inconnue : ${inconnue}` };
  const e = brute;
  const identifiantExterne = mot(e.identifiantExterne, 200);
  const agent = mot(e.agent, 100);
  const modeMot = mot(e.mode, 100);
  if (!identifiantExterne || !agent || !modeMot) return { ok: false, raison: 'identifiant, agent ou mode manquant' };
  if (!STATUTS_AGENTS.includes(e.statut as StatutAgent)) return { ok: false, raison: 'statut inconnu' };
  const debut = dateJournal(e.debut);
  if (!debut) return { ok: false, raison: 'début illisible' };
  let fin: string | undefined;
  if (e.fin !== undefined) {
    const f = dateJournal(e.fin);
    if (!f) return { ok: false, raison: 'fin illisible' };
    fin = f < debut ? debut : f;
  }
  const dureeMs = nombre(e.dureeMs); const tours = nombre(e.tours);
  const jetonsEntree = nombre(e.jetonsEntree); const jetonsSortie = nombre(e.jetonsSortie); const cout = nombre(e.coutEstime);
  if (dureeMs === null || tours === null || jetonsEntree === null || jetonsSortie === null || cout === null) return { ok: false, raison: 'nombre manquant ou négatif' };
  if (!Array.isArray(e.modeles) || !e.modeles.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 200)) return { ok: false, raison: 'modèles invalides' };
  if (!Array.isArray(e.etapes) || !Array.isArray(e.sources) || !Array.isArray(e.actions)) return { ok: false, raison: 'étapes, sources ou actions manquantes' };

  const etapes: EtapeAgent[] = [];
  for (const brut of e.etapes.slice(0, ETAPES_MAX)) {
    if (!estObjet(brut) || inconnues(brut, CLES_ETAPE) || !TYPES_ETAPES.includes(brut.type as TypeEtape)) return { ok: false, raison: 'étape invalide' };
    const etape: EtapeAgent = { type: brut.type as TypeEtape };
    for (const k of ['outil', 'modele'] as const) if (brut[k] !== undefined) { const v = mot(brut[k], 200); if (!v) return { ok: false, raison: `étape : ${k} invalide` }; etape[k] = v; }
    if (brut.codeErreur !== undefined) { if (typeof brut.codeErreur !== 'string') return { ok: false, raison: 'étape : code invalide' }; etape.codeErreur = masquerTexte(brut.codeErreur.slice(0, 200)); }
    if (brut.succes !== undefined) { if (typeof brut.succes !== 'boolean') return { ok: false, raison: 'étape : succès invalide' }; etape.succes = brut.succes; }
    for (const k of ['dureeMs', 'jetonsEntree', 'jetonsSortie'] as const) if (brut[k] !== undefined) { const n = nombre(brut[k]); if (n === null) return { ok: false, raison: `étape : ${k} invalide` }; etape[k] = Math.round(n); }
    for (const k of ['arguments', 'resultat'] as const) if (brut[k] !== undefined) { if (typeof brut[k] !== 'string') return { ok: false, raison: `étape : ${k} invalide` }; etape[k] = masquerTexte((brut[k] as string).slice(0, TEXTE_MAX)); }
    etapes.push(etape);
  }
  const sources: SourceAgent[] = [];
  for (const brut of e.sources.slice(0, SOURCES_MAX)) {
    if (!estObjet(brut) || inconnues(brut, CLES_SOURCE)) return { ok: false, raison: 'source invalide' };
    const titre = mot(brut.titre, 500);
    if (!titre) return { ok: false, raison: 'source sans titre' };
    const source: SourceAgent = { titre: masquerTexte(titre) };
    if (typeof brut.url === 'string') { const u = adresseSansSecret(brut.url); if (!u) return { ok: false, raison: 'source : adresse invalide' }; source.url = u; }
    if (typeof brut.reference === 'string' && brut.reference) source.reference = masquerTexte(brut.reference.slice(0, 500));
    if (!source.url && !source.reference) return { ok: false, raison: 'source sans adresse ni référence' };
    if (typeof brut.extrait === 'string') source.extrait = masquerTexte(brut.extrait.slice(0, TEXTE_MAX));
    sources.push(source);
  }
  const actions: ActionAgent[] = [];
  for (const brut of e.actions.slice(0, ACTIONS_MAX)) {
    if (!estObjet(brut) || inconnues(brut, CLES_ACTION) || !ETATS_ACTIONS.includes(brut.etat as EtatAction)) return { ok: false, raison: 'action invalide' };
    const outil = mot(brut.outil, 200); const proposee = dateJournal(brut.proposeeLe);
    if (!outil || !proposee) return { ok: false, raison: 'action : outil ou date manquants' };
    const action: ActionAgent = { outil, etat: brut.etat as EtatAction, proposeeLe: proposee < debut ? debut : proposee };
    for (const k of ['confirmeeLe', 'refuseeLe', 'annuleeLe', 'executeeLe'] as const) {
      if (brut[k] === undefined) continue;
      const d = dateJournal(brut[k]);
      if (!d) return { ok: false, raison: `action : ${k} illisible` };
      action[k] = d < debut ? debut : d;
    }
    actions.push(action);
  }

  const sortie: ExecutionAgent = {
    identifiantExterne, environnement: mot(e.environnement, 50) ?? 'production', agent, mode: modeMot,
    statut: e.statut as StatutAgent,
    modeles: e.modeles as string[], tours: Math.round(tours), dureeMs: Math.round(dureeMs),
    jetonsEntree: Math.round(jetonsEntree), jetonsSortie: Math.round(jetonsSortie), coutEstime: cout,
    debut, etapes, sources, actions
  };
  if (fin) sortie.fin = fin;
  if (typeof e.utilisateur === 'string' && e.utilisateur) sortie.utilisateur = e.utilisateur.slice(0, 200);
  if (typeof e.question === 'string') sortie.question = masquerTexte(e.question.slice(0, TEXTE_MAX));
  if (typeof e.reponse === 'string') sortie.reponse = masquerTexte(e.reponse.slice(0, TEXTE_MAX));
  if (typeof e.erreur === 'string') sortie.erreur = masquerTexte(e.erreur.slice(0, ERREUR_MAX));
  return { ok: true, execution: sortie };
}

// ——— Client ———

export interface OptionsJournalAgents {
  /** Adresse du tableau de bord (http ou https). */
  adresse: string;
  /** Clé publique du projet (`clj_pub_…`). */
  cle: string;
  /** `fetch` à utiliser (tests, environnement sans fetch global). */
  fetch?: typeof globalThis.fetch;
  /** Délai maximal d'une requête (10 s par défaut). */
  delaiMs?: number;
  /** Écrit dans la console pourquoi une exécution est refusée ou un lot abandonné. Faux par défaut : silence. */
  debug?: boolean;
  /** Réglages de la file en mémoire. */
  file?: { max?: number; reculBaseMs?: number; reculMaxMs?: number };
  /** Faux : aucune minuterie de reprise (tests). */
  minuterie?: boolean;
  /** Horloge (tests). */
  maintenant?: () => number;
  /** Transport complet (tests) ; remplace `fetch`. */
  transport?: Transport;
}

export interface JournalAgents {
  /** Valide, masque, met en file et tente l'envoi. Ne lève jamais ; rend ce qui a été accepté ou refusé en local. */
  envoyer(executions: ExecutionAgent[]): Promise<{ acceptees: number; refusees: number }>;
  /** Tente d'envoyer ce qui attend. Ne lève jamais. */
  vider(): Promise<void>;
  /** Le nombre d'exécutions en attente d'envoi. */
  enAttente(): number;
  /** Arrête les reprises ; la file est abandonnée. */
  arreter(): void;
}

function journalInactif(): JournalAgents {
  return { envoyer: async () => ({ acceptees: 0, refusees: 0 }), vider: async () => {}, enAttente: () => 0, arreter: () => {} };
}

export function creerJournalAgents(options: OptionsJournalAgents): JournalAgents {
  try {
    if (!options || typeof options.adresse !== 'string' || !/^https?:\/\//.test(options.adresse) || typeof options.cle !== 'string' || !options.cle.trim()) {
      return journalInactif();
    }
    return creerActif(options);
  } catch {
    return journalInactif();
  }
}

function creerActif(options: OptionsJournalAgents): JournalAgents {
  const adresse = options.adresse.replace(/\/+$/, '');
  const transport = options.transport ?? transportFetch(options.delaiMs ?? 10_000, options.fetch);
  const maintenant = options.maintenant ?? (() => Date.now());
  const max = Math.max(1, options.file?.max ?? FILE_AGENTS_MAX);
  const reculBase = options.file?.reculBaseMs ?? RECUL_AGENTS_BASE_MS;
  const reculMax = options.file?.reculMaxMs ?? RECUL_AGENTS_MAX_MS;
  let file: ExecutionAgent[] = [];
  let echecs = 0;
  let pauseJusqua = 0;
  let enCours: Promise<void> | null = null;
  let minuterie: ReturnType<typeof setTimeout> | null = null;
  let arrete = false;

  const avertir = (message: string): void => {
    if (!options.debug) return;
    try { console.warn(`[centrale/agents] ${message}`); } catch { /* même la console peut manquer */ }
  };
  const recul = (): number => Math.min(reculMax, reculBase * 2 ** Math.max(0, echecs - 1));

  function planifier(delai: number): void {
    if (arrete || options.minuterie === false || !file.length) return;
    try {
      if (minuterie) clearTimeout(minuterie);
      minuterie = setTimeout(() => { minuterie = null; void vider(); }, Math.max(delai, pauseJusqua - maintenant(), 0));
      (minuterie as { unref?: () => void }).unref?.();
    } catch { /* sans importance */ }
  }

  function prendreLot(): { lot: ExecutionAgent[]; corps: string } | null {
    while (file.length) {
      let n = Math.min(file.length, EXECUTIONS_MAX_PAR_LOT);
      while (n >= 1) {
        const lot = file.slice(0, n);
        const corps = JSON.stringify({ executions: lot });
        if (new TextEncoder().encode(corps).length <= TAILLE_MAX_ENVOI) { file.splice(0, n); return { lot, corps }; }
        if (n === 1) break;
        n = Math.ceil(n / 2);
      }
      avertir('exécution trop grosse, abandonnée');
      file.shift();
    }
    return null;
  }

  function remettre(lot: ExecutionAgent[]): void {
    file = [...lot, ...file].slice(-max);
  }

  async function boucle(): Promise<void> {
    while (file.length) {
      if (maintenant() < pauseJusqua) return;
      const pris = prendreLot();
      if (!pris) return;
      let statut = 0;
      let reessayerApres: string | null | undefined;
      try {
        const reponse = await transport({ url: `${adresse}/v1/agents`, entetes: { 'Content-Type': 'application/json', 'X-Centrale-Cle': options.cle }, corps: pris.corps });
        statut = Number(reponse?.statut) || 0;
        reessayerApres = reponse?.reessayerApres;
      } catch {
        avertir('envoi impossible (hors ligne ?)');
      }
      if (statut >= 200 && statut < 300) { echecs = 0; continue; }
      if (statut >= 400 && statut < 500 && statut !== 408 && statut !== 429) {
        avertir(`lot refusé (${statut}), abandonné`);
        continue;
      }
      echecs++;
      const demande = statut === 429 ? lireRetryAfter(reessayerApres, maintenant()) : null;
      pauseJusqua = maintenant() + (demande ?? recul());
      remettre(pris.lot);
      planifier(0);
      return;
    }
  }

  function vider(): Promise<void> {
    if (!enCours) {
      enCours = boucle().catch(() => avertir('vidage interrompu')).finally(() => { enCours = null; });
    }
    return enCours;
  }

  return {
    async envoyer(executions) {
      let acceptees = 0; let refusees = 0;
      try {
        if (arrete) return { acceptees, refusees };
        for (const brute of Array.isArray(executions) ? executions : []) {
          const v = validerExecution(brute);
          if (!v.ok) { refusees++; avertir(`exécution refusée : ${v.raison}`); continue; }
          file.push(v.execution);
          acceptees++;
          if (file.length > max) file.shift();
        }
        await vider();
      } catch { /* ne lève jamais */ }
      return { acceptees, refusees };
    },
    vider: async () => { try { await vider(); } catch { /* ne lève jamais */ } },
    enAttente: () => file.length,
    arreter() {
      arrete = true;
      file = [];
      if (minuterie) { clearTimeout(minuterie); minuterie = null; }
    }
  };
}
