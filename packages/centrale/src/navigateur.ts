/**
 * `@astratra/centrale/navigateur` : applications web (SPA ou non).
 * - erreurs (`error`) et promesses rejetées (`unhandledrejection`), sans remplacer `window.onerror` ;
 * - vues : première page avec son temps de chargement, puis pushState / replaceState / popstate, en gabarit ;
 * - sessions : début à l'ouverture, fin quand la page passe en arrière-plan ;
 * - envoi final par `navigator.sendBeacon` (adresse avec `?cle=`) quand la page est cachée ;
 * - surveillance renforcée (vigilance.ts) : requêtes `fetch`, `console.error`, page bloquée, et avec un `stockage`
 *   (par exemple `localStorage`, un seul onglet à la fois) la mémoire d'un chargement à l'autre.
 * Aucun cookie ; aucun stockage local sans `stockage`.
 */

import { gabaritAdresse } from './masquage.ts';
import { creerCentrale, definirCentraleParDefaut, NOM_SDK } from './coeur.ts';
import type { Centrale, ConfigCentrale, ReglagesInternes } from './coeur.ts';
import type { Transport } from './transport.ts';
import { memoireLancement, suivreConsole, suivreRequetes, surveillerBlocages } from './vigilance.ts';
import type { ConsoleSuivie, MemoireLancement, StockageCentrale } from './vigilance.ts';

export * from './index.ts';

/** Taille maximale d'un envoi par balise (les navigateurs limitent à 64 Kio au total). */
export const TAILLE_BALISE = 60_000;

export interface ConfigNavigateur extends ConfigCentrale {
  /** Transforme un chemin en nom de vue (par défaut : gabaritAdresse). */
  gabarit?: (chemin: string) => string;
  /** Suivre les sessions (vrai par défaut). */
  sessions?: boolean;
  /** Requêtes `fetch` suivies (vrai par défaut). */
  requetes?: boolean;
  /** `console.error` signalé, `console.warn` dans le fil d'Ariane (vrai par défaut). */
  console?: boolean;
  /** Page bloquée signalée (vrai par défaut). */
  blocages?: boolean;
  /**
   * Où garder l'état d'un chargement à l'autre (par exemple `{ lire: (c) => localStorage.getItem(c), ecrire: (c, v) =>
   * localStorage.setItem(c, v) }`) : un onglet fermé par plantage est alors signalé. Partagé entre onglets : à
   * réserver aux apps ouvertes dans un seul onglet.
   */
  stockage?: StockageCentrale;
}

/** Ce que le paquet utilise du navigateur ; injectable pour les tests. */
export interface EnvironnementNavigateur {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState' | 'readyState'>;
  location: Pick<Location, 'pathname'>;
  history: Pick<History, 'pushState' | 'replaceState'>;
  navigator?: { onLine?: boolean; language?: string; userAgent?: string; sendBeacon?: (url: string, corps?: BodyInit | null) => boolean };
  performance?: { getEntriesByType?: (type: string) => unknown[] };
  console?: ConsoleSuivie;
}

export interface CentraleNavigateur extends Centrale {
  debrancher(): void;
}

/** Système d'exploitation grossier, tiré de l'agent utilisateur (jamais de version précise). */
export function systemeDepuisAgent(agent: string | undefined): string | undefined {
  if (!agent) return undefined;
  if (/iPhone|iPad|iPod/.test(agent)) return 'iOS';
  if (/Android/.test(agent)) return 'Android';
  if (/Mac OS X|Macintosh/.test(agent)) return 'macOS';
  if (/Windows/.test(agent)) return 'Windows';
  if (/CrOS/.test(agent)) return 'ChromeOS';
  if (/Linux/.test(agent)) return 'Linux';
  return undefined;
}

function environnementGlobal(): EnvironnementNavigateur | undefined {
  const g = globalThis as unknown as Partial<EnvironnementNavigateur>;
  if (!g.window || !g.document || !g.location || !g.history) return undefined;
  return g as EnvironnementNavigateur;
}

/** Durée de chargement de la page (navigation), en millisecondes, si le navigateur la connaît. */
function dureeChargement(env: EnvironnementNavigateur): number | undefined {
  try {
    const entree = env.performance?.getEntriesByType?.('navigation')?.[0] as { loadEventEnd?: number; duration?: number } | undefined;
    const valeur = entree?.loadEventEnd || entree?.duration;
    return typeof valeur === 'number' && valeur > 0 ? valeur : undefined;
  } catch {
    return undefined;
  }
}

export function demarrer(config: ConfigNavigateur, transport?: Transport, env: EnvironnementNavigateur | undefined = environnementGlobal(), reglages: ReglagesInternes = {}): CentraleNavigateur {
  const nettoyages: Array<() => void> = [];
  const enLigne = () => env?.navigator?.onLine !== false;
  const centrale = creerCentrale(
    {
      plateforme: 'web',
      ...config,
      contexte: { os: systemeDepuisAgent(env?.navigator?.userAgent), langue: env?.navigator?.language, ...config?.contexte }
    },
    transport,
    { nomSdk: `${NOM_SDK}/navigateur`, enLigne, ...reglages }
  );
  const resultat: CentraleNavigateur = {
    ...centrale,
    debrancher: () => {
      for (const n of nettoyages.splice(0).reverse()) { try { n(); } catch { /* rien */ } }
      centrale.arreter();
    }
  };
  let memoire: MemoireLancement | undefined;
  resultat.miette = (categorie, message, donnees) => { centrale.miette(categorie, message, donnees); memoire?.garder(); };
  if (!centrale.actif || !env) return resultat;
  definirCentraleParDefaut(resultat);

  try {
    const { window: w, document: d } = env;
    const ecouter = (cible: EnvironnementNavigateur['window'] | EnvironnementNavigateur['document'], type: string, fn: (ev: never) => void) => {
      cible.addEventListener(type, fn as EventListener);
      nettoyages.push(() => cible.removeEventListener(type, fn as EventListener));
    };
    const nommer = (chemin: string): string => {
      try { return config.gabarit ? config.gabarit(chemin) : gabaritAdresse(chemin); } catch { return gabaritAdresse(chemin); }
    };

    // ——— Erreurs ———
    ecouter(w, 'error', (ev: { error?: unknown; message?: string; filename?: string; lineno?: number; colno?: number }) => {
      if (ev.error) centrale.erreur(ev.error);
      // « Script error. » d'un script d'une autre origine : seul le message est connu.
      else if (ev.message) centrale.erreur({ name: 'Error', message: ev.message, stack: ev.filename ? `@${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : undefined });
    });
    ecouter(w, 'unhandledrejection', (ev: { reason?: unknown }) => {
      centrale.erreur(ev.reason, { etiquettes: { origine: 'unhandledrejection' } });
    });

    // ——— Surveillance renforcée ———
    if (config.requetes !== false) nettoyages.push(suivreRequetes(resultat, w as unknown as { fetch?: unknown }, { adresseCentrale: config.adresse, maintenant: reglages.maintenant }));
    if (config.console !== false && env.console) nettoyages.push(suivreConsole(resultat, env.console, reglages.maintenant));
    const gardien = config.blocages !== false ? surveillerBlocages(resultat, { minuterie: reglages.minuterie, maintenant: reglages.maintenant }) : undefined;
    if (gardien) nettoyages.push(() => gardien.arreter());

    // ——— Vues ———
    let vueCourante = nommer(env.location.pathname);
    const changementDeVue = () => {
      const nom = nommer(env.location.pathname);
      if (nom === vueCourante) return;
      resultat.miette('navigation', `${vueCourante} → ${nom}`);
      vueCourante = nom;
      centrale.vue(nom);
      memoire?.garder({ ecran: nom });
    };
    for (const methode of ['pushState', 'replaceState'] as const) {
      const historique = env.history as unknown as Record<string, (...a: unknown[]) => unknown>;
      const originale = historique[methode];
      if (typeof originale !== 'function') continue;
      const remplacee = function (this: unknown, ...args: unknown[]) {
        const retour = originale.apply(this, args);
        try { changementDeVue(); } catch { /* jamais chez l'appelant */ }
        return retour;
      };
      historique[methode] = remplacee;
      nettoyages.push(() => { if (historique[methode] === remplacee) historique[methode] = originale; });
    }
    ecouter(w, 'popstate', () => changementDeVue());

    // La session commence avant la première vue, pour que celle-ci en fasse partie.
    const sessions = config.sessions !== false;
    if (sessions) centrale.session('debut');

    const premiereVue = () => centrale.vue(vueCourante, dureeChargement(env));
    if (d.readyState === 'complete') premiereVue();
    else {
      // loadEventEnd n'est connu qu'après la fin de l'événement load.
      let fait = false;
      ecouter(w, 'load', () => { if (!fait) { fait = true; setTimeout(premiereVue, 0); } });
    }

    // ——— Sessions et envoi final ———
    const envoyerBalise = env.navigator?.sendBeacon?.bind(env.navigator);
    ecouter(d, 'visibilitychange', () => {
      if (d.visibilityState === 'hidden') {
        // Page cachée : les minuteries ralentissent, le gardien se tait jusqu'au retour.
        gardien?.pause();
        if (sessions && centrale.sessionCourante()) centrale.session('ok');
        memoire?.garderMaintenant({ premierPlan: false });
        if (envoyerBalise) centrale.viderParBalise((url, corps) => envoyerBalise(url, corps), TAILLE_BALISE);
        else void centrale.vider();
      } else if (d.visibilityState === 'visible') {
        gardien?.reprise();
        if (sessions && !centrale.sessionCourante()) centrale.session('debut');
        memoire?.garderMaintenant({ premierPlan: true });
      }
    });
    // De retour en ligne : on envoie ce qui attendait.
    ecouter(w, 'online', () => { void centrale.vider(); });
    if (config.stockage) {
      memoire = memoireLancement(resultat, config.stockage, { maintenant: reglages.maintenant });
      memoire.garder({ ecran: vueCourante });
      const m = memoire;
      nettoyages.push(() => m.arreter());
      void m.reprendre();
    }
  } catch (err) {
    if (config.debug) console.warn('[centrale] branchement navigateur incomplet', err);
  }
  return resultat;
}
