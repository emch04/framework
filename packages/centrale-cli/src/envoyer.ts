/**
 * `centrale envoyer-cartes <dossier> --version X` et `centrale deploiement …` : le dialogue avec
 * le backend, authentifié par le jeton de déploiement du projet (`clj_dep_…`).
 *
 * L'envoi des cartes se fait en trois temps :
 * 1. on liste les cartes du dossier et leur identifiant (celui posé par `injecter`, sinon un
 *    identifiant tiré du contenu : le backend retrouvera alors la carte par version et nom de fichier) ;
 * 2. on demande au backend celles qu'il a déjà (`POST /v1/cartes/connues`) : rien n'est renvoyé deux fois ;
 * 3. on envoie le reste par lots compressés (`POST /v1/cartes`), chaque lot étant réessayé avec un
 *    recul progressif en cas de coupure, de 5xx ou de 429 (`Retry-After` respecté).
 */

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { cheminRelatif, debugIdDe, fichiersDe } from './injecter.ts';

/** Taille visée d'un lot, avant compression : assez petite pour un réseau moyen, assez grande pour aller vite. */
export const LOT_OCTETS = 16 * 1024 * 1024;
/** Le maximum accepté par le backend pour un lot une fois décompressé. */
export const LOT_MAX_OCTETS = 64 * 1024 * 1024;
const CONNUES_PAR_DEMANDE = 1000;

export interface Connexion {
  adresse: string;
  jeton: string;
  /** Injectables pour les tests. */
  fetch?: typeof fetch;
  attendre?: (ms: number) => Promise<void>;
  essais?: number;
  reculBaseMs?: number;
}

export class ErreurCentrale extends Error {
  statut: number;
  constructor(message: string, statut: number) { super(message); this.statut = statut; }
}

const attendreVraiment = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Une requête JSON (gzip pour les gros corps), réessayée sur coupure, 408, 429 et 5xx. */
export async function appeler(connexion: Connexion, chemin: string, corps: unknown): Promise<unknown> {
  const f = connexion.fetch ?? fetch;
  const attendre = connexion.attendre ?? attendreVraiment;
  const essais = Math.max(1, connexion.essais ?? 5);
  const base = connexion.reculBaseMs ?? 1000;
  const texte = JSON.stringify(corps);
  const compresse = texte.length > 1024;
  const contenu = compresse ? gzipSync(texte) : texte;
  const adresse = connexion.adresse.replace(/\/+$/, '') + chemin;
  let derniere: unknown;
  for (let essai = 1; essai <= essais; essai++) {
    let reponse: Response;
    try {
      reponse = await f(adresse, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connexion.jeton}`,
          'Content-Type': 'application/json',
          ...(compresse ? { 'Content-Encoding': 'gzip' } : {})
        },
        body: contenu
      });
    } catch (erreur) {
      derniere = erreur;
      if (essai < essais) await attendre(base * 2 ** (essai - 1));
      continue;
    }
    const lu = await reponse.text();
    let json: unknown = null;
    try { json = lu ? JSON.parse(lu) : null; } catch { /* réponse non JSON : on garde le statut */ }
    if (reponse.ok) return json;
    const message = (json as { message?: string } | null)?.message ?? `HTTP ${reponse.status}`;
    derniere = new ErreurCentrale(message, reponse.status);
    const temporaire = reponse.status === 408 || reponse.status === 429 || reponse.status >= 500;
    if (!temporaire || essai === essais) break;
    const demande = Number(reponse.headers.get('retry-after'));
    await attendre(Number.isFinite(demande) && demande > 0 ? Math.min(demande, 300) * 1000 : base * 2 ** (essai - 1));
  }
  throw derniere instanceof Error ? derniere : new ErreurCentrale(String(derniere), 0);
}

export interface CarteLocale {
  chemin: string;
  /** Chemin du fichier généré relatif au dossier (sans `.map`), par exemple `assets/index-BxK3.js`. */
  fichier: string;
  debugId: string;
  taille: number;
  /** Vrai si l'identifiant vient d'`injecter` (sinon il est tiré du contenu). */
  injecte: boolean;
}

/** Les cartes d'un dossier de build et leur identifiant. Les cartes de CSS sont laissées de côté. */
export function cartesDe(dossier: string): CarteLocale[] {
  const sortie: CarteLocale[] = [];
  for (const chemin of fichiersDe(dossier)) {
    if (!chemin.endsWith('.map') || chemin.endsWith('.css.map')) continue;
    const texte = readFileSync(chemin, 'utf8');
    let carte: Record<string, unknown>;
    try { carte = JSON.parse(texte); } catch { continue; }
    if (!carte || typeof carte !== 'object' || typeof carte.mappings !== 'string') continue;
    const pose = typeof carte.debug_id === 'string' ? carte.debug_id : typeof carte.debugId === 'string' ? carte.debugId : null;
    sortie.push({
      chemin,
      fichier: cheminRelatif(dossier, chemin).replace(/\.map$/, ''),
      debugId: (pose ?? debugIdDe(texte)).toLowerCase(),
      taille: statSync(chemin).size,
      injecte: pose !== null
    });
  }
  return sortie;
}

export interface BilanEnvoi {
  envoyees: string[];
  dejaConnues: string[];
  tropGrosses: string[];
  refusees: Array<{ debugId: string; raison: string }>;
}

export async function envoyerCartes(
  connexion: Connexion,
  { dossier, version, lotOctets = LOT_OCTETS, signaler = () => {} }: { dossier: string; version?: string; lotOctets?: number; signaler?: (message: string) => void }
): Promise<BilanEnvoi> {
  const cartes = cartesDe(dossier);
  const bilan: BilanEnvoi = { envoyees: [], dejaConnues: [], tropGrosses: [], refusees: [] };

  const connues = new Set<string>();
  for (let i = 0; i < cartes.length; i += CONNUES_PAR_DEMANDE) {
    const morceau = cartes.slice(i, i + CONNUES_PAR_DEMANDE).map((c) => c.debugId);
    const reponse = await appeler(connexion, '/v1/cartes/connues', { debugIds: morceau }) as { connues?: string[] };
    for (const id of reponse?.connues ?? []) connues.add(id.toLowerCase());
  }

  const aEnvoyer: CarteLocale[] = [];
  for (const c of cartes) {
    if (connues.has(c.debugId)) bilan.dejaConnues.push(c.debugId);
    else if (c.taille > LOT_MAX_OCTETS - 1024) bilan.tropGrosses.push(c.fichier);
    else aEnvoyer.push(c);
  }

  /* Des lots d'au plus `lotOctets` (une carte plus grosse part seule). */
  let lot: CarteLocale[] = [];
  let taille = 0;
  const partir = async () => {
    if (!lot.length) return;
    const corps = {
      ...(version ? { version } : {}),
      cartes: lot.map((c) => ({ debugId: c.debugId, fichier: c.fichier, carte: readFileSync(c.chemin, 'utf8') }))
    };
    const reponse = await appeler(connexion, '/v1/cartes', corps) as Partial<BilanEnvoi> & { enregistrees?: string[] };
    bilan.envoyees.push(...(reponse?.enregistrees ?? []));
    bilan.dejaConnues.push(...(reponse?.dejaConnues ?? []));
    bilan.refusees.push(...(reponse?.refusees ?? []));
    signaler(`${bilan.envoyees.length + bilan.dejaConnues.length}/${cartes.length}`);
    lot = [];
    taille = 0;
  };
  for (const c of aEnvoyer) {
    if (lot.length && taille + c.taille > lotOctets) await partir();
    lot.push(c);
    taille += c.taille;
  }
  await partir();
  return bilan;
}

export interface Deploiement {
  version: string;
  commit: string;
  depot?: string;
  environnement?: string;
  deployeLe?: string;
}

export async function declarerDeploiement(connexion: Connexion, deploiement: Deploiement): Promise<unknown> {
  return appeler(connexion, '/v1/deploiements', deploiement);
}
