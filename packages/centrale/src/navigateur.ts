/**
 * `@astratra/centrale/navigateur` : applications web (SPA ou non).
 * - erreurs (`error`) et promesses rejetées (`unhandledrejection`), sans remplacer `window.onerror` ;
 * - vues : première page avec son temps de chargement, puis pushState / replaceState / popstate, en gabarit ;
 * - sessions : début à l'ouverture, fin quand la page passe en arrière-plan ;
 * - envoi final par `navigator.sendBeacon` (adresse avec `?cle=`) quand la page est cachée.
 * Aucun cookie, aucun stockage local.
 */

import { gabaritAdresse } from './masquage.ts';
import { creerCentrale, definirCentraleParDefaut, NOM_SDK } from './coeur.ts';
import type { Centrale, ConfigCentrale, ReglagesInternes } from './coeur.ts';
import type { Transport } from './transport.ts';

export * from './index.ts';

/** Taille maximale d'un envoi par balise (les navigateurs limitent à 64 Kio au total). */
export const TAILLE_BALISE = 60_000;

export interface ConfigNavigateur extends ConfigCentrale {
  /** Transforme un chemin en nom de vue (par défaut : gabaritAdresse). */
  gabarit?: (chemin: string) => string;
  /** Suivre les sessions (vrai par défaut). */
  sessions?: boolean;
}

/** Ce que le paquet utilise du navigateur ; injectable pour les tests. */
export interface EnvironnementNavigateur {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState' | 'readyState'>;
  location: Pick<Location, 'pathname'>;
  history: Pick<History, 'pushState' | 'replaceState'>;
  navigator?: { onLine?: boolean; language?: string; userAgent?: string; sendBeacon?: (url: string, corps?: BodyInit | null) => boolean };
  performance?: { getEntriesByType?: (type: string) => unknown[] };
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

    // ——— Vues ———
    let vueCourante = nommer(env.location.pathname);
    const changementDeVue = () => {
      const nom = nommer(env.location.pathname);
      if (nom === vueCourante) return;
      centrale.miette('navigation', `${vueCourante} → ${nom}`);
      vueCourante = nom;
      centrale.vue(nom);
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
        if (sessions && centrale.sessionCourante()) centrale.session('ok');
        if (envoyerBalise) centrale.viderParBalise((url, corps) => envoyerBalise(url, corps), TAILLE_BALISE);
        else void centrale.vider();
      } else if (d.visibilityState === 'visible' && sessions && !centrale.sessionCourante()) {
        centrale.session('debut');
      }
    });
    // De retour en ligne : on envoie ce qui attendait.
    ecouter(w, 'online', () => { void centrale.vider(); });
  } catch (err) {
    if (config.debug) console.warn('[centrale] branchement navigateur incomplet', err);
  }
  return resultat;
}
