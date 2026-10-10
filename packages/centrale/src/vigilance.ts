/**
 * La surveillance renforcée, commune au navigateur et à Expo (même rôle que `Vigilance.swift` du paquet Swift) :
 * - les requêtes sortantes (`fetch`) dans le fil d'Ariane, avec leur gabarit, leur statut et leur durée ;
 *   celles qui échouent (pas de réponse, 5xx, 408, 429) sont signalées ;
 * - `console.error` (signalé) et `console.warn` (fil d'Ariane) ;
 * - le gardien du fil principal : une interface bloquée plus de 2 s est signalée avec sa durée ;
 * - la mémoire d'un lancement à l'autre : le fil d'Ariane, l'écran et la session ouverte sont gardés au fil de
 *   l'eau ; au lancement suivant, une session restée ouverte est close « anormale » (ou « plantage »), et une
 *   fermeture au premier plan est signalée avec ce qui se passait juste avant.
 * Rien ne lève jamais chez l'appelant ; sans aucune dépendance.
 */

import type { Centrale } from './coeur.ts';
import type { Miette } from './envoi.ts';
import { gabaritAdresse } from './masquage.ts';

/** Au-delà, le fil principal est considéré bloqué. */
export const SEUIL_BLOCAGE_MS = 2_000;
/** Un blocage plus long est une erreur (le système tue une app bloquée trop longtemps). */
export const BLOCAGE_GRAVE_MS = 5_000;
/** Un même message de console n'est signalé qu'une fois dans ce délai. */
export const REPIT_CONSOLE_MS = 10_000;

type Nettoyage = () => void;

// ——— Requêtes sortantes ———

/** Le gabarit d'une adresse de requête : son chemin sans identifiants ni paramètres (« /v1/titres/:id »). */
export function gabaritRequete(adresse: string): string {
  try {
    const url = new URL(adresse, 'http://local');
    const hote = url.host === 'local' ? '' : url.host;
    return hote + gabaritAdresse(url.pathname);
  } catch {
    return gabaritAdresse(String(adresse).split('?')[0] ?? '');
  }
}

export interface OptionsRequetes {
  /** L'adresse de la Centrale : ses propres envois ne sont jamais suivis (sinon ils se signaleraient en boucle). */
  adresseCentrale: string;
  maintenant?: () => number;
}

/** Remplace `cible.fetch` par une version suivie. Rend de quoi la remettre. */
export function suivreRequetes(centrale: Centrale, cible: { fetch?: unknown }, options: OptionsRequetes): Nettoyage {
  const originale = cible.fetch as ((entree: unknown, init?: { method?: string }) => Promise<{ status: number }>) | undefined;
  if (typeof originale !== 'function') return () => undefined;
  const maintenant = options.maintenant ?? (() => Date.now());
  const centraleHote = (() => { try { return new URL(options.adresseCentrale).host; } catch { return ''; } })();
  const suivie = function (this: unknown, entree: unknown, init?: { method?: string }) {
    let adresse = '';
    let methode = 'GET';
    try {
      const objet = entree as { url?: string; method?: string } | undefined;
      adresse = typeof entree === 'string' ? entree : String(objet?.url ?? entree ?? '');
      methode = String(init?.method ?? objet?.method ?? 'GET').toUpperCase();
    } catch { /* rien */ }
    const debut = maintenant();
    const appel = originale.call(this, entree, init);
    try {
      if (centraleHote && adresse.includes(centraleHote)) return appel;
    } catch { return appel; }
    const noter = (statut: number) => {
      try {
        const gabarit = gabaritRequete(adresse);
        const dureeMs = Math.max(0, Math.round(maintenant() - debut));
        centrale.miette('requete', `${methode} ${gabarit}`, { statut, dureeMs });
        if (statut === 0 || statut >= 500 || statut === 408 || statut === 429) {
          centrale.erreur(
            { name: statut === 0 ? 'RequeteSansReponse' : 'RequeteEchouee', message: statut === 0 ? `Pas de réponse : ${methode} ${gabarit}` : `Le serveur a répondu ${statut} : ${methode} ${gabarit}` },
            { niveau: statut === 0 || statut >= 500 ? 'erreur' : 'avertissement', etiquettes: { source: 'reseau', statut: String(statut), requete: `${methode} ${gabarit}` }, pile: [] }
          );
        }
      } catch { /* jamais chez l'appelant */ }
    };
    return appel.then(
      (reponse) => { noter(Number(reponse?.status) || 0); return reponse; },
      (erreur: unknown) => {
        // Une requête annulée exprès n'est pas un échec.
        if ((erreur as { name?: string })?.name !== 'AbortError') noter(0);
        throw erreur;
      }
    );
  };
  cible.fetch = suivie;
  return () => { if (cible.fetch === suivie) cible.fetch = originale; };
}

// ——— Console ———

export interface ConsoleSuivie {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

function texteConsole(args: unknown[]): { texte: string; erreur?: unknown } {
  const erreur = args.find((a) => a instanceof Error);
  const texte = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  return { texte: texte.slice(0, 500), erreur };
}

/** `console.error` signalé (une fois par message dans un court délai), `console.warn` dans le fil d'Ariane. */
export function suivreConsole(centrale: Centrale, cible: ConsoleSuivie, maintenant: () => number = () => Date.now()): Nettoyage {
  const deja = new Map<string, number>();
  let dedans = false;
  const nettoyages: Nettoyage[] = [];
  for (const niveau of ['error', 'warn'] as const) {
    const originale = cible[niveau];
    if (typeof originale !== 'function') continue;
    const suivie = function (this: unknown, ...args: unknown[]) {
      if (!dedans) {
        dedans = true; // la Centrale elle-même peut écrire dans la console : jamais de boucle
        try {
          const { texte, erreur } = texteConsole(args);
          centrale.miette('console', `${niveau === 'error' ? 'Erreur' : 'Avertissement'} : ${texte}`);
          if (niveau === 'error') {
            const t = maintenant();
            if (t - (deja.get(texte) ?? -Infinity) >= REPIT_CONSOLE_MS) {
              deja.set(texte, t);
              if (deja.size > 100) deja.delete(deja.keys().next().value as string);
              centrale.erreur(erreur ?? { name: 'ConsoleError', message: texte }, { niveau: 'avertissement', etiquettes: { source: 'console' } });
            }
          }
        } catch { /* rien */ } finally { dedans = false; }
      }
      return originale.apply(this, args);
    };
    cible[niveau] = suivie;
    nettoyages.push(() => { if (cible[niveau] === suivie) cible[niveau] = originale; });
  }
  return () => { for (const n of nettoyages) n(); };
}

// ——— Gardien du fil principal ———

export interface Gardien {
  /** À l'arrière-plan, les minuteries sont suspendues : le gardien se tait jusqu'au retour. */
  pause(): void;
  reprise(): void;
  arreter(): void;
  /** Pour les tests : un tic de la minuterie, à l'instant donné. */
  tic(instant: number): void;
}

export interface OptionsGardien {
  seuilMs?: number;
  pasMs?: number;
  maintenant?: () => number;
  /** false : pas de minuterie (les tests appellent `tic`). */
  minuterie?: boolean;
  /** Appelé au début (avec l'instant) et à la fin (null) d'un blocage, pour le garder sur le disque. */
  noter?: (debut: number | null) => void;
}

/**
 * Une minuterie toutes les 500 ms : si elle arrive bien plus tard que prévu, le fil principal était bloqué.
 * Le blocage est signalé quand il se termine, avec sa durée (avertissement, erreur au-delà de 5 s).
 */
export function surveillerBlocages(centrale: Centrale, options: OptionsGardien = {}): Gardien {
  const seuil = options.seuilMs ?? SEUIL_BLOCAGE_MS;
  const pas = options.pasMs ?? 500;
  const maintenant = options.maintenant ?? (() => Date.now());
  let precedent = maintenant();
  let enPause = false;
  let minuterie: ReturnType<typeof setInterval> | null = null;
  const tic = (instant: number) => {
    try {
      const ecart = instant - precedent - pas;
      precedent = instant;
      if (enPause || ecart < seuil) return;
      const secondes = Math.round(ecart / 100) / 10;
      centrale.miette('autre', `Interface bloquée ${secondes} s`);
      centrale.erreur(
        { name: 'AppBloquee', message: `L'interface n'a pas répondu pendant ${secondes} s.` },
        { niveau: ecart >= BLOCAGE_GRAVE_MS ? 'erreur' : 'avertissement', etiquettes: { duree_s: String(secondes) }, pile: [] }
      );
    } catch { /* rien */ }
  };
  const lancer = () => {
    if (options.minuterie === false || minuterie) return;
    minuterie = setInterval(() => tic(maintenant()), pas);
    (minuterie as { unref?: () => void }).unref?.();
  };
  lancer();
  return {
    pause: () => { enPause = true; if (minuterie) clearInterval(minuterie); minuterie = null; },
    reprise: () => { enPause = false; precedent = maintenant(); lancer(); },
    arreter: () => { enPause = true; if (minuterie) clearInterval(minuterie); minuterie = null; },
    tic
  };
}

// ——— Mémoire d'un lancement à l'autre ———

/** Où garder l'état entre deux lancements : `localStorage`, AsyncStorage, un fichier… (lecture et écriture de texte). */
export interface StockageCentrale {
  lire(cle: string): string | null | undefined | Promise<string | null | undefined>;
  ecrire(cle: string, valeur: string): void | Promise<void>;
}

export interface EtatLancement {
  sessionId?: string;
  premierPlan: boolean;
  /** Une erreur fatale a été vue (plantage JavaScript). */
  fatale?: boolean;
  ecran?: string;
  miettes: Miette[];
  horodatage: string;
}

export const CLE_ETAT = 'astratra-centrale:etat';

export interface MemoireLancement {
  /** Lit l'état du lancement précédent et signale ce qu'il faut. À appeler une fois, au démarrage. */
  reprendre(): Promise<void>;
  /** Garde l'état courant (regroupé : au plus une écriture par seconde). */
  garder(changement?: Partial<Pick<EtatLancement, 'premierPlan' | 'fatale' | 'ecran'>>): void;
  /** Garde tout de suite (erreur fatale, départ en arrière-plan). */
  garderMaintenant(changement?: Partial<Pick<EtatLancement, 'premierPlan' | 'fatale' | 'ecran'>>): void;
  arreter(): void;
}

export function memoireLancement(centrale: Centrale, stockage: StockageCentrale, options: { maintenant?: () => number; delaiMs?: number } = {}): MemoireLancement {
  const maintenant = options.maintenant ?? (() => Date.now());
  const delai = options.delaiMs ?? 1_000;
  let etat: Omit<EtatLancement, 'miettes' | 'sessionId' | 'horodatage'> = { premierPlan: true };
  let attente: ReturnType<typeof setTimeout> | null = null;
  let pret = false;
  const ecrire = () => {
    try {
      const complet: EtatLancement = {
        ...etat, sessionId: centrale.sessionCourante(), miettes: centrale.filAriane(), horodatage: new Date(maintenant()).toISOString()
      };
      const resultat = stockage.ecrire(CLE_ETAT, JSON.stringify(complet));
      if (resultat && typeof (resultat as Promise<void>).catch === 'function') (resultat as Promise<void>).catch(() => undefined);
    } catch { /* rien */ }
  };
  const garderMaintenant: MemoireLancement['garderMaintenant'] = (changement) => {
    etat = { ...etat, ...changement };
    if (!pret) return; // l'état précédent n'est pas encore lu : on ne l'écrase pas
    if (attente) clearTimeout(attente);
    attente = null;
    ecrire();
  };
  return {
    async reprendre() {
      try {
        const texte = await stockage.lire(CLE_ETAT);
        const precedent = texte ? JSON.parse(texte) as EtatLancement : undefined;
        if (precedent?.sessionId) {
          centrale.sessionPrecedente(precedent.sessionId, precedent.fatale ? 'plantage' : 'anormal');
          // Fermée au premier plan sans plantage vu : mémoire, chien de garde, plantage natif, arrêt forcé.
          if (precedent.premierPlan && !precedent.fatale) {
            centrale.erreur(
              { name: 'FermetureInattendue', message: "L'app s'est fermée au premier plan sans se terminer normalement." },
              {
                niveau: 'fatal', horodatage: precedent.horodatage, pile: [],
                filAriane: Array.isArray(precedent.miettes) ? precedent.miettes : [],
                etiquettes: precedent.ecran ? { ecran: String(precedent.ecran) } : undefined
              }
            );
          }
        }
      } catch { /* état illisible : ignoré */ }
      pret = true;
      ecrire();
    },
    garder(changement) {
      etat = { ...etat, ...changement };
      if (!pret || attente) return;
      attente = setTimeout(() => { attente = null; ecrire(); }, delai);
      (attente as { unref?: () => void }).unref?.();
    },
    garderMaintenant,
    arreter() { if (attente) clearTimeout(attente); attente = null; }
  };
}
