/**
 * `@astratra/centrale/expo` : applications Expo / React Native, sans aucune dépendance.
 * - erreurs JavaScript via `ErrorUtils.setGlobalHandler` (fatale => plantage), le gestionnaire
 *   précédent est toujours rappelé ;
 * - sessions liées à `AppState` : une session se termine après 30 s en arrière-plan ;
 * - `ecran(nom)` à appeler depuis la navigation ;
 * - contexte (plateforme, version, build, mise à jour) lu dans des valeurs INJECTÉES : aucun import
 *   d'expo-constants ni de react-native ;
 * - `signalerPlantageNatif(rapport)` pour le futur module natif (MetricKit, raison de dernière fermeture Android) ;
 * - surveillance renforcée (vigilance.ts) : requêtes `fetch`, `console.error`, promesses rejetées (Hermes), app
 *   bloquée, alerte mémoire d'iOS, et avec un `stockage` la mémoire d'un lancement à l'autre (fermeture inattendue
 *   signalée avec le fil d'Ariane et l'écran).
 */

import type { Cadre } from './envoi.ts';
import { creerCentrale, definirCentraleParDefaut, NOM_SDK } from './coeur.ts';
import type { Centrale, ConfigCentrale, ReglagesInternes } from './coeur.ts';
import type { Transport } from './transport.ts';
import { memoireLancement, suivreConsole, suivreRequetes, surveillerBlocages } from './vigilance.ts';
import type { ConsoleSuivie, MemoireLancement, StockageCentrale } from './vigilance.ts';

export * from './index.ts';

/** Au-delà de ce temps en arrière-plan, la session est terminée. */
export const ARRIERE_PLAN_MS = 30_000;
/** Temps laissé au vidage avant de rendre la main au gestionnaire d'erreurs précédent, sur une erreur fatale. */
export const DELAI_FATAL_MS = 2_000;

type GestionnaireGlobal = (erreur: unknown, estFatale?: boolean) => void;

/** Le `ErrorUtils` global de React Native. */
export interface ErrorUtilsRN {
  setGlobalHandler(gestionnaire: GestionnaireGlobal): void;
  getGlobalHandler(): GestionnaireGlobal | undefined;
}

/** L'objet `AppState` de React Native. */
export interface AppStateRN {
  currentState?: string | null;
  addEventListener(type: 'change' | 'memoryWarning', ecouteur: (etat: string) => void): { remove(): void } | undefined;
}

export interface ConfigExpo extends ConfigCentrale {
  plateforme: 'ios' | 'android';
  /** Par exemple `Constants.expoConfig.version`. */
  version?: string;
  /** Numéro de build natif. */
  build?: string;
  /** `Updates.updateId`, s'il y en a un. */
  miseAJour?: string;
  /** Par exemple `${Platform.OS} ${Platform.Version}`. */
  os?: string;
  /** Modèle d'appareil (ignoré en mode strict). */
  appareil?: string;
  langue?: string;
  /** `AppState` de react-native, pour les sessions. */
  appState?: AppStateRN;
  /** `ErrorUtils` ; par défaut, le global de React Native. */
  errorUtils?: ErrorUtilsRN;
  /**
   * Où garder l'état entre deux lancements (AsyncStorage, expo-file-system, SecureStore…). Sans lui, une app
   * tuée par le système (mémoire, plantage natif) n'est pas vue.
   */
  stockage?: StockageCentrale;
  /** Requêtes `fetch` suivies (vrai par défaut). */
  requetes?: boolean;
  /** `console.error` signalé, `console.warn` dans le fil d'Ariane (vrai par défaut). */
  console?: boolean;
  /** Gardien du fil JavaScript : interface bloquée signalée (vrai par défaut). */
  blocages?: boolean;
  /** Promesses rejetées sans `catch` signalées, par Hermes (vrai par défaut). */
  promesses?: boolean;
  /** Où trouver `fetch`, `console` et `HermesInternal` ; par défaut, `globalThis` (surtout pour les tests). */
  globaux?: { fetch?: unknown; console?: ConsoleSuivie; HermesInternal?: HermesRN };
}

interface HermesRN {
  enablePromiseRejectionTracker?(options: { allRejections: boolean; onUnhandled: (id: number, erreur: unknown) => void }): void;
}

/** Ce que remontera le module natif : un plantage de la session précédente. */
export interface RapportPlantageNatif {
  /** Par exemple « EXC_BAD_ACCESS », « ANR », « SIGABRT », « OutOfMemory ». */
  type: string;
  message?: string;
  /** Quand le plantage a eu lieu (il est signalé au lancement suivant). */
  horodatage?: string | Date;
  /** Pile déjà lue, ou texte brut. */
  pile?: Cadre[] | string;
  /** Raison donnée par le système (ApplicationExitInfo.reason, MetricKit…). */
  raison?: string;
  debugId?: string;
}

export interface CentraleExpo extends Centrale {
  /** À appeler à chaque changement d'écran (par exemple depuis `onStateChange` de React Navigation). */
  ecran(nom: string): void;
  signalerPlantageNatif(rapport: RapportPlantageNatif): void;
  debrancher(): void;
}

export function demarrer(config: ConfigExpo, transport?: Transport, reglages: ReglagesInternes = {}): CentraleExpo {
  const maintenant = reglages.maintenant ?? (() => Date.now());
  const centrale = creerCentrale(
    {
      ...config,
      plateforme: config?.plateforme === 'android' ? 'android' : 'ios',
      contexte: {
        build: config?.build, miseAJour: config?.miseAJour, os: config?.os, appareil: config?.appareil, langue: config?.langue,
        ...config?.contexte
      }
    },
    transport,
    { nomSdk: `${NOM_SDK}/expo`, ...reglages }
  );
  const nettoyages: Array<() => void> = [];
  let ecranCourant: string | undefined;
  let memoire: MemoireLancement | undefined;

  const resultat: CentraleExpo = {
    ...centrale,
    ecran: (nom: string) => {
      try {
        if (!nom || nom === ecranCourant) return;
        centrale.miette('navigation', ecranCourant ? `${ecranCourant} → ${nom}` : nom);
        ecranCourant = nom;
        centrale.vue(nom);
        memoire?.garder({ ecran: nom });
      } catch { /* jamais chez l'appelant */ }
    },
    signalerPlantageNatif: (rapport: RapportPlantageNatif) => {
      try {
        const pile = typeof rapport?.pile === 'string' ? undefined : rapport?.pile;
        centrale.erreur(
          { name: String(rapport?.type ?? 'PlantageNatif'), message: rapport?.message ?? rapport?.raison ?? '', stack: typeof rapport?.pile === 'string' ? rapport.pile : undefined },
          {
            niveau: 'fatal',
            horodatage: rapport?.horodatage,
            pile,
            debugId: rapport?.debugId,
            etiquettes: { source: 'natif', ...(rapport?.raison ? { raison: rapport.raison } : {}) }
          }
        );
      } catch { /* jamais chez l'appelant */ }
    },
    debrancher: () => {
      for (const n of nettoyages.splice(0).reverse()) { try { n(); } catch { /* rien */ } }
      centrale.arreter();
    }
  };
  // Chaque miette part aussi dans l'état gardé sur le disque.
  resultat.miette = (categorie, message, donnees) => { centrale.miette(categorie, message, donnees); memoire?.garder(); };
  if (!centrale.actif) return resultat;
  definirCentraleParDefaut(resultat);

  try {
    // ——— Erreurs JavaScript ———
    const errorUtils = config.errorUtils ?? (globalThis as { ErrorUtils?: ErrorUtilsRN }).ErrorUtils;
    if (errorUtils && typeof errorUtils.setGlobalHandler === 'function') {
      const precedent = errorUtils.getGlobalHandler?.();
      const gestionnaire: GestionnaireGlobal = (erreur, estFatale) => {
        const suite = () => { if (precedent) precedent(erreur, estFatale); };
        try {
          centrale.erreur(erreur, { niveau: estFatale ? 'fatal' : 'erreur' });
          if (estFatale) {
            memoire?.garderMaintenant({ fatale: true });
            if (centrale.sessionCourante()) centrale.session('plantage');
            // On laisse un court délai au vidage avant que le gestionnaire précédent n'arrête l'app.
            let rendu = false;
            const rendre = () => { if (!rendu) { rendu = true; suite(); } };
            setTimeout(rendre, DELAI_FATAL_MS);
            centrale.vider().finally(rendre);
            return;
          }
        } catch { /* jamais chez l'appelant */ }
        suite();
      };
      errorUtils.setGlobalHandler(gestionnaire);
      nettoyages.push(() => { if (precedent) errorUtils.setGlobalHandler(precedent); });
    }

    // ——— Surveillance renforcée ———
    const global = config.globaux ?? (globalThis as { fetch?: unknown; console?: ConsoleSuivie; HermesInternal?: HermesRN });
    if (config.requetes !== false) nettoyages.push(suivreRequetes(resultat, global, { adresseCentrale: config.adresse, maintenant }));
    if (config.console !== false && global.console) nettoyages.push(suivreConsole(resultat, global.console, maintenant));
    const gardien = config.blocages !== false ? surveillerBlocages(resultat, { minuterie: reglages.minuterie }) : undefined;
    if (gardien) nettoyages.push(() => gardien.arreter());
    if (config.promesses !== false) {
      try {
        global.HermesInternal?.enablePromiseRejectionTracker?.({
          allRejections: true,
          onUnhandled: (_id, erreur) => { centrale.erreur(erreur, { etiquettes: { origine: 'promesse' } }); }
        });
      } catch { /* rien */ }
    }

    // ——— Sessions ———
    const appState = config.appState;
    let depuisArrierePlan: number | null = null;
    let minuterie: ReturnType<typeof setTimeout> | null = null;
    const finirSession = () => {
      if (centrale.sessionCourante()) centrale.session('ok');
      memoire?.garderMaintenant({ premierPlan: false });
      void centrale.vider();
    };
    const annuler = () => { if (minuterie) clearTimeout(minuterie); minuterie = null; };
    const surEtat = (etat: string) => {
      if (etat === 'active') {
        annuler();
        gardien?.reprise();
        resultat.miette('autre', 'Premier plan');
        // La minuterie peut ne pas avoir tourné (JavaScript suspendu en arrière-plan).
        if (depuisArrierePlan !== null && maintenant() - depuisArrierePlan >= ARRIERE_PLAN_MS) finirSession();
        depuisArrierePlan = null;
        if (!centrale.sessionCourante()) centrale.session('debut');
        memoire?.garderMaintenant({ premierPlan: true });
      } else if (etat === 'inactive') {
        // Centre de contrôle, sélecteur d'apps, verrouillage en cours : JavaScript peut s'arrêter juste après.
        gardien?.pause();
      } else if (etat === 'background') {
        if (depuisArrierePlan === null) depuisArrierePlan = maintenant();
        // En arrière-plan, JavaScript est suspendu : le gardien prendrait la suspension pour un blocage.
        gardien?.pause();
        resultat.miette('autre', 'Arrière-plan');
        memoire?.garderMaintenant({ premierPlan: false });
        void centrale.vider();
        annuler();
        minuterie = setTimeout(() => { minuterie = null; finirSession(); }, ARRIERE_PLAN_MS);
      }
    };
    if (appState) {
      const abonnement = appState.addEventListener('change', (etat) => { try { surEtat(etat); } catch { /* rien */ } });
      // iOS manque de mémoire : l'app risque d'être fermée.
      let derniereAlerte = -Infinity;
      const memoireBasse = appState.addEventListener('memoryWarning', () => {
        try {
          resultat.miette('autre', 'Mémoire saturée');
          if (maintenant() - derniereAlerte < 60_000) return;
          derniereAlerte = maintenant();
          centrale.erreur({ name: 'MemoireSaturee', message: "Le système manque de mémoire : l'app risque d'être fermée." }, { niveau: 'avertissement', pile: [] });
        } catch { /* rien */ }
      });
      nettoyages.push(() => { annuler(); abonnement?.remove(); memoireBasse?.remove(); });
      if (!appState.currentState || appState.currentState === 'active') centrale.session('debut');
    } else {
      centrale.session('debut');
    }
    // L'état du lancement précédent, puis le nôtre, gardés entre deux lancements.
    if (config.stockage) {
      memoire = memoireLancement(resultat, config.stockage, { maintenant });
      const m = memoire;
      nettoyages.push(() => m.arreter());
      void m.reprendre();
    }
    resultat.miette('autre', "Lancement de l'app");
  } catch (err) {
    if (config.debug) console.warn('[centrale] branchement Expo incomplet', err);
  }
  return resultat;
}
