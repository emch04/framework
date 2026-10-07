/**
 * `@astratra/centrale/node` : serveurs Node (Express ou non).
 * - erreurs non attrapées et promesses rejetées sans gestionnaire, sans changer le comportement normal ;
 * - intergiciel Express (identifiant de requête, durée, statut, miette) et gestionnaire d'erreurs Express ;
 * - vidage de la file à la sortie (beforeExit, SIGTERM, SIGINT).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { gabaritAdresse } from './masquage.ts';
import { centraleParDefaut, creerCentrale, definirCentraleParDefaut, NOM_SDK } from './coeur.ts';
import type { Centrale, ConfigCentrale, PorteeCentrale, ReglagesInternes } from './coeur.ts';
import type { Transport } from './transport.ts';

export * from './index.ts';

/** Délai maximal accordé au vidage avant que le processus ne s'arrête. */
export const DELAI_SORTIE_MS = 2_000;

export interface ConfigNode extends ConfigCentrale {
  /** Brancher les erreurs non attrapées et les promesses rejetées (vrai par défaut). */
  capterErreurs?: boolean;
  /** Vider la file à la sortie (vrai par défaut). */
  viderALaSortie?: boolean;
}

export interface CentraleNode extends Centrale {
  intergiciel(): IntergicielExpress;
  gestionnaireErreurs(): GestionnaireErreursExpress;
  /** Débranche tous les écouteurs posés par `demarrer` et arrête la minuterie. */
  debrancher(): void;
}

// Types minimaux d'Express : le paquet ne dépend pas d'Express.
export interface RequeteExpress {
  method: string;
  originalUrl?: string;
  url?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  headers: Record<string, string | string[] | undefined>;
}
export interface ReponseExpress {
  statusCode: number;
  headersSent?: boolean;
  on(evenement: string, ecouteur: () => void): unknown;
  setHeader?(nom: string, valeur: string): unknown;
}
export type IntergicielExpress = (req: RequeteExpress, res: ReponseExpress, next: (err?: unknown) => void) => void;
export type GestionnaireErreursExpress = (err: unknown, req: RequeteExpress, res: ReponseExpress, next: (err?: unknown) => void) => void;

interface InfosRequete {
  idRequete: string;
  debut: number;
  portee: PorteeCentrale;
  /** Route complète (montage + chemin déclaré), notée au moment où Express la choisit. */
  route?: string;
}

const INFOS = Symbol.for('astratra.centrale.requete');
const stockage = new AsyncLocalStorage<PorteeCentrale>();
/** Erreurs déjà enregistrées, pour ne pas les compter deux fois (gestionnaire Express puis non attrapée). */
const dejaVues = new WeakSet<object>();

function marquer(e: unknown): boolean {
  if (!e || typeof e !== 'object') return true;
  if (dejaVues.has(e)) return false;
  dejaVues.add(e);
  return true;
}

function infos(req: RequeteExpress): InfosRequete | undefined {
  return (req as unknown as Record<symbol, InfosRequete | undefined>)[INFOS];
}

/** La route en gabarit : le chemin déclaré dans Express s'il existe, sinon l'adresse ramenée au gabarit. */
function route(req: RequeteExpress): string {
  const notee = infos(req)?.route;
  if (notee) return notee;
  const chemin = req.route?.path;
  if (typeof chemin === 'string') return gabaritAdresse(`${req.baseUrl ?? ''}${chemin}`) || '/';
  return gabaritAdresse(req.originalUrl ?? req.url ?? '/') || '/';
}

function modeRejets(): string {
  const options = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  for (const option of options) {
    const m = /^--unhandled-rejections=(.+)$/.exec(option);
    if (m) return m[1];
  }
  return 'throw';
}

export function intergiciel(centrale: Centrale | undefined = centraleParDefaut()): IntergicielExpress {
  return (req, res, next) => {
    let infosRequete: InfosRequete | undefined;
    try {
      const entete = req.headers['x-request-id'];
      const recu = Array.isArray(entete) ? entete[0] : entete;
      const idRequete = recu && /^[\w.:-]{1,100}$/.test(recu) ? recu : randomUUID();
      const debut = performance.now();
      const portee: PorteeCentrale = { miettes: [], requete: { methode: req.method, route: route(req), idRequete } };
      infosRequete = { idRequete, debut, portee };
      (req as unknown as Record<symbol, InfosRequete>)[INFOS] = infosRequete;
      // Express remet `baseUrl` à zéro en sortant d'un routeur monté : on note la route complète
      // au moment où elle est choisie (affectation de `req.route`).
      const notee = infosRequete;
      let routeExpress = req.route;
      Object.defineProperty(req, 'route', {
        configurable: true,
        enumerable: true,
        get: () => routeExpress,
        set: (valeur: RequeteExpress['route']) => {
          routeExpress = valeur;
          try {
            if (typeof valeur?.path === 'string') notee.route = gabaritAdresse(`${req.baseUrl ?? ''}${valeur.path}`) || '/';
          } catch { /* rien */ }
        }
      });
      try { if (!res.headersSent) res.setHeader?.('X-Request-Id', idRequete); } catch { /* en-têtes déjà partis */ }
      res.on('finish', () => {
        try {
          const dureeMs = Math.round(performance.now() - debut);
          const chemin = route(req);
          if (portee.requete) Object.assign(portee.requete, { route: chemin, statut: res.statusCode, dureeMs });
          // La requête est finie : sa miette va dans le fil global, hors de sa portée.
          stockage.exit(() => (centrale ?? centraleParDefaut())?.miette('requete', `${req.method} ${chemin}`, { statut: res.statusCode, dureeMs, idRequete }));
        } catch { /* jamais chez l'appelant */ }
      });
    } catch {
      infosRequete = undefined;
    }
    // La suite de la requête s'exécute dans sa portée : ses miettes et sa requête suivent les erreurs.
    if (infosRequete) stockage.run(infosRequete.portee, () => next());
    else next();
  };
}

export function gestionnaireErreurs(centrale: Centrale | undefined = centraleParDefaut()): GestionnaireErreursExpress {
  return (err, req, res, next) => {
    try {
      const c = centrale ?? centraleParDefaut();
      if (c && marquer(err)) {
        const e = err as { status?: unknown; statusCode?: unknown } | undefined;
        const declare = Number(e?.status ?? e?.statusCode);
        const statut = Number.isInteger(declare) && declare >= 400 && declare < 600
          ? declare
          : (res.statusCode >= 400 ? res.statusCode : 500);
        const i = infos(req);
        c.erreur(err, {
          niveau: statut >= 500 ? 'erreur' : 'avertissement',
          requete: {
            methode: req.method,
            route: route(req),
            statut,
            dureeMs: i ? Math.round(performance.now() - i.debut) : undefined,
            idRequete: i?.idRequete
          }
        });
      }
    } catch { /* jamais chez l'appelant */ }
    next(err);
  };
}

/** Attend le vidage au plus `delaiMs`, sans garder le processus en vie. */
function viderAvecDelai(centrale: Centrale, delaiMs: number): Promise<void> {
  return new Promise((resoudre) => {
    const minuterie = setTimeout(resoudre, delaiMs);
    minuterie.unref?.();
    centrale.vider().finally(() => { clearTimeout(minuterie); resoudre(); });
  });
}

/** Démarre la collecte pour un serveur Node. Ne lève jamais. */
export function demarrer(config: ConfigNode, transport?: Transport, reglages: ReglagesInternes = {}): CentraleNode {
  const centrale = creerCentrale(
    {
      plateforme: 'serveur',
      racine: process.cwd(),
      ...config,
      contexte: { os: `${os.platform()} ${os.release()}`, ...config?.contexte }
    },
    transport,
    { nomSdk: `${NOM_SDK}/node`, portee: () => stockage.getStore(), ...reglages }
  );
  const nettoyages: Array<() => void> = [];
  const resultat: CentraleNode = {
    ...centrale,
    actif: centrale.actif,
    config: centrale.config,
    intergiciel: () => intergiciel(centrale),
    gestionnaireErreurs: () => gestionnaireErreurs(centrale),
    debrancher: () => {
      for (const n of nettoyages.splice(0)) { try { n(); } catch { /* rien */ } }
      centrale.arreter();
      if (centraleParDefaut() === resultat) definirCentraleParDefaut(undefined);
    }
  };
  if (!centrale.actif) return resultat;
  definirCentraleParDefaut(resultat);

  const ecouter = (evenement: string, ecouteur: (...a: never[]) => void) => {
    process.on(evenement, ecouteur as (...a: unknown[]) => void);
    nettoyages.push(() => process.off(evenement, ecouteur as (...a: unknown[]) => void));
  };

  try {
    if (config.capterErreurs !== false) {
      // Exception non attrapée : on l'enregistre, puis on reproduit le comportement de Node
      // (pile sur la sortie d'erreur, code 1) si personne d'autre ne s'en occupe.
      const surException = (erreur: unknown) => {
        if (marquer(erreur)) centrale.erreur(erreur, { niveau: 'fatal' });
        if (centrale.sessionCourante()) centrale.session('plantage');
        if (process.listenerCount('uncaughtException') > 1) return;
        try {
          const texte = erreur instanceof Error ? (erreur.stack ?? String(erreur)) : `Uncaught ${String(erreur)}`;
          process.stderr.write(`${texte}\n`);
        } catch { /* rien */ }
        void viderAvecDelai(centrale, DELAI_SORTIE_MS).finally(() => process.exit(1));
      };
      ecouter('uncaughtException', surException);

      // Promesse rejetée sans gestionnaire : en mode par défaut (« throw »), Node plante ;
      // on relance donc la raison pour garder ce comportement (l'exception ci-dessus l'enregistre).
      const surRejet = (raison: unknown) => {
        const seul = process.listenerCount('unhandledRejection') === 1;
        if (seul && modeRejets() === 'throw') throw raison;
        if (marquer(raison)) centrale.erreur(raison, { niveau: 'erreur', etiquettes: { origine: 'unhandledRejection' } });
      };
      ecouter('unhandledRejection', surRejet);
    }

    if (config.viderALaSortie !== false) {
      let tentatives = 0;
      ecouter('beforeExit', () => {
        if (centrale.enAttente() > 0 && tentatives++ < 3) void centrale.vider();
      });
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        const surSignal = () => {
          process.off(signal, surSignal);
          void viderAvecDelai(centrale, DELAI_SORTIE_MS).finally(() => {
            // Personne d'autre n'écoute ce signal : on le relance pour l'arrêt normal.
            if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
          });
        };
        ecouter(signal, surSignal);
      }
    }
  } catch (err) {
    if (config.debug) console.warn('[centrale] branchement Node incomplet', err);
  }
  return resultat;
}
