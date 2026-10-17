/**
 * Le cœur du paquet de collecte : file d'attente bornée, contexte, fil d'Ariane,
 * masquage à la source et envoi par lots. Commun à Node, au navigateur et à Expo.
 *
 * Règle d'or : rien ici ne lève chez l'appelant. Toute erreur interne est avalée
 * (au plus un `console.warn` en mode debug) et le projet hôte n'est jamais bloqué.
 */

import type {
  Cadre, Contexte, Envoi, Evenement, EvenementErreur, EvenementIA, EvenementSession, EvenementUsage, EvenementVue,
  Miette, Niveau
} from './envoi.ts';
import { EVENEMENTS_MAX_PAR_ENVOI, MIETTES_MAX, TAILLE_MAX_ENVOI, VERSION_ENVOI } from './envoi.ts';
import { gabaritAdresse, masquerTexte, masquerValeur } from './masquage.ts';
import { analyserPile } from './pile.ts';
import { associerDebugIds } from './debugIds.ts';
import { sha256Hex, tailleOctets } from './sha256.ts';
import { lireRetryAfter, transportFetch } from './transport.ts';
import type { Transport } from './transport.ts';

export const NOM_SDK = '@astratra/centrale';
export const VERSION_SDK = '1.6.0';

/** Valeurs par défaut de la file et de l'envoi. */
export const FILE_MAX = 500;
export const SEUIL_LOT = 50;
export const INTERVALLE_MS = 10_000;
export const RECUL_BASE_MS = 2_000;
export const RECUL_MAX_MS = 5 * 60_000;
const MESSAGE_MAX = 4_000;
const TEXTE_PROPRIETE_MAX = 200;

export interface ConfigCentrale {
  /** Clé publique du projet (`clj_pub_…`) : elle sert seulement à envoyer. */
  cle: string;
  /** Adresse du backend, par exemple `https://centrale.exemple.fr`. */
  adresse: string;
  environnement: Contexte['environnement'];
  /** Version de l'app ou du serveur. */
  version?: string;
  /** Sel du projet pour hacher l'identifiant d'utilisateur. */
  sel?: string;
  /** Noms propres à masquer partout (élèves, clients…). */
  noms?: string[];
  /** Taux entre 0 et 1 pour les vues, usages et appels d'IA. Les erreurs et sessions ne sont jamais échantillonnées. */
  echantillonnage?: { vues?: number; usages?: number; ia?: number };
  /** Mode strict : ni utilisateur, ni appareil précis. */
  strict?: boolean;
  /** Coupe tout (refus de l'utilisateur, tests…). */
  desactive?: boolean;
  /** Affiche les erreurs internes avec `console.warn`. */
  debug?: boolean;
  /** Renseignés par les points d'entrée (node, navigateur, expo) ; rarement à fournir à la main. */
  plateforme?: Contexte['plateforme'];
  contexte?: Partial<Pick<Contexte, 'build' | 'miseAJour' | 'os' | 'appareil' | 'langue'>>;
  /** Préfixe retiré des chemins de fichiers des piles. */
  racine?: string;
  /** Réglages fins de la file (surtout pour les tests). */
  file?: { max?: number; seuil?: number; intervalleMs?: number; reculBaseMs?: number; reculMaxMs?: number };
}

/** Options internes, pour les points d'entrée et les tests. */
export interface ReglagesInternes {
  maintenant?: () => number;
  aleatoire?: () => number;
  /** false : pas de minuterie automatique (les tests appellent `vider()`). */
  minuterie?: boolean;
  /** Dit si l'appareil est en ligne ; hors ligne, la file attend. */
  enLigne?: () => boolean;
  /** Portée courante (une requête Node, par exemple) : son propre fil d'Ariane et sa requête. */
  portee?: () => PorteeCentrale | undefined;
  /** Nom du SDK envoyé, par exemple `@astratra/centrale/node`. */
  nomSdk?: string;
}

export interface PorteeCentrale {
  miettes: Miette[];
  requete?: EvenementErreur['requete'];
}

export interface ExtraErreur {
  niveau?: Niveau;
  etiquettes?: Record<string, string>;
  empreinte?: string[];
  requete?: EvenementErreur['requete'];
  debugId?: string;
  /** Horodatage de l'erreur, si elle est plus ancienne que maintenant (plantage natif). */
  horodatage?: string | Date;
  /** Pile déjà lue (plantage natif), à la place de celle de l'erreur. */
  pile?: Cadre[];
  /** Fil d'Ariane d'un lancement précédent (fermeture inattendue), à la place du fil courant. */
  filAriane?: Miette[];
}

export type InfosIA = Omit<EvenementIA, 'type' | 'horodatage'>;

export interface Centrale {
  /** Enregistre une erreur. Rend l'identifiant de l'événement (ou undefined si rien n'est gardé). */
  erreur(e: unknown, extra?: ExtraErreur): string | undefined;
  vue(nom: string, dureeChargementMs?: number): void;
  usage(nom: string, proprietes?: Record<string, unknown>): void;
  ia(infos: InfosIA): void;
  session(etat: EvenementSession['etat']): void;
  miette(categorie: Miette['categorie'], message: string, donnees?: Record<string, unknown>): void;
  definirUtilisateur(id: string | number | null | undefined): void;
  /** Complète le contexte (os, langue, version…). Ignore l'appareil en mode strict. */
  definirContexte(partiel: Partial<Omit<Contexte, 'utilisateur' | 'sessionId' | 'environnement'>>): void;
  /** Envoie tout ce qui peut l'être maintenant. Ne rejette jamais. */
  vider(): Promise<void>;
  /**
   * Vide la file de façon synchrone par une « balise » (navigator.sendBeacon), quand la page se ferme.
   * `envoyer` reçoit l'adresse avec `?cle=` et le corps ; s'il rend false, les événements restent en file.
   */
  viderParBalise(envoyer: (url: string, corps: string) => boolean, tailleMax?: number): void;
  /** Arrête la minuterie (les événements restent en file). */
  arreter(): void;
  /** Nombre d'événements en attente. */
  enAttente(): number;
  /** Identifiant de la session en cours, s'il y en a une. */
  sessionCourante(): string | undefined;
  /** Copie du fil d'Ariane courant (pour le garder entre deux lancements). */
  filAriane(): Miette[];
  /** Clôt la session restée ouverte d'un lancement précédent (« anormal » ou « plantage »). */
  sessionPrecedente(id: string, etat: 'anormal' | 'plantage'): void;
  readonly actif: boolean;
  readonly config: Readonly<ConfigCentrale>;
}

interface Entree {
  evenement: Evenement;
  contexte: Contexte;
}

/** Plus la valeur est basse, plus l'événement est jeté tôt quand la file déborde. */
function priorite(e: Evenement): number {
  if (e.type === 'erreur') return 2;
  if (e.type === 'session') return 1;
  return 0;
}

function identifiant(aleatoire: () => number): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(aleatoire() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${((Math.floor(aleatoire() * 4) + 8).toString(16))}${hex(3)}-${hex(12)}`;
}

function borner(texte: string, max: number): string {
  return texte.length > max ? texte.slice(0, max - 1) + '…' : texte;
}

/** Ne garde que des propriétés simples (chaîne courte, nombre fini, booléen). */
function proprietesSimples(source: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const sortie: Record<string, string | number | boolean> = {};
  for (const [cle, valeur] of Object.entries(source)) {
    if (typeof valeur === 'string') sortie[cle] = borner(valeur, TEXTE_PROPRIETE_MAX);
    else if (typeof valeur === 'number' && Number.isFinite(valeur)) sortie[cle] = valeur;
    else if (typeof valeur === 'boolean') sortie[cle] = valeur;
  }
  return Object.keys(sortie).length ? sortie : undefined;
}

function taux(valeur: number | undefined): number {
  if (typeof valeur !== 'number' || Number.isNaN(valeur)) return 1;
  return Math.min(1, Math.max(0, valeur));
}

/** Une instance qui ne fait rien : pour `desactive`, ou si la configuration est inutilisable. */
function centraleInactive(config: ConfigCentrale): Centrale {
  const rien = () => undefined;
  return {
    erreur: rien, vue: rien, usage: rien, ia: rien, session: rien, miette: rien,
    definirUtilisateur: rien, definirContexte: rien, viderParBalise: rien, arreter: rien,
    vider: () => Promise.resolve(),
    enAttente: () => 0,
    sessionCourante: rien,
    filAriane: () => [],
    sessionPrecedente: rien,
    actif: false,
    config
  };
}

let parDefaut: Centrale | undefined;

/** L'instance créée par le dernier `demarrer()` (utilisée par `mesurerAppelIA`, `intergiciel`…). */
export function centraleParDefaut(): Centrale | undefined {
  return parDefaut;
}

export function definirCentraleParDefaut(c: Centrale | undefined): void {
  parDefaut = c;
}

export function creerCentrale(config: ConfigCentrale, transport?: Transport, reglages: ReglagesInternes = {}): Centrale {
  try {
    if (!config || config.desactive) return centraleInactive(config ?? ({} as ConfigCentrale));
    return creerCentraleActive(config, transport ?? transportFetch(), reglages);
  } catch (err) {
    if (config?.debug) console.warn('[centrale] configuration inutilisable', err);
    return centraleInactive(config ?? ({} as ConfigCentrale));
  }
}

function creerCentraleActive(config: ConfigCentrale, transport: Transport, reglages: ReglagesInternes): Centrale {
  const maintenant = reglages.maintenant ?? (() => Date.now());
  const aleatoire = reglages.aleatoire ?? Math.random;
  const max = Math.max(1, config.file?.max ?? FILE_MAX);
  const seuil = Math.max(1, config.file?.seuil ?? SEUIL_LOT);
  const intervalleMs = config.file?.intervalleMs ?? INTERVALLE_MS;
  const reculBaseMs = config.file?.reculBaseMs ?? RECUL_BASE_MS;
  const reculMaxMs = config.file?.reculMaxMs ?? RECUL_MAX_MS;
  const optionsMasquage = { noms: config.noms ?? [] };
  const adresse = String(config.adresse ?? '').replace(/\/+$/, '');
  const nomSdk = reglages.nomSdk ?? NOM_SDK;

  const avertir = (message: string, err?: unknown) => {
    if (config.debug) {
      try { console.warn(`[centrale] ${message}`, err ?? ''); } catch { /* même la console peut manquer */ }
    }
  };

  const contexteInitial: Contexte = {
    environnement: config.environnement ?? 'production',
    plateforme: config.plateforme ?? 'serveur'
  };
  if (config.version) contexteInitial.version = config.version;
  for (const [cle, valeur] of Object.entries(config.contexte ?? {})) {
    if (valeur === undefined || valeur === null || valeur === '') continue;
    if (cle === 'appareil' && config.strict) continue;
    (contexteInitial as unknown as Record<string, unknown>)[cle] = masquerTexte(String(valeur), optionsMasquage);
  }
  // Le contexte est remplacé (jamais modifié) : chaque événement garde celui de son moment.
  let contexte: Contexte = contexteInitial;

  let file: Entree[] = [];
  const miettes: Miette[] = [];
  let debutSession = 0;
  let erreursSession = 0;
  let echecs = 0;
  let pauseJusqua = 0;
  let enCours: Promise<void> | null = null;
  let minuterie: ReturnType<typeof setTimeout> | null = null;
  let arrete = false;

  const horodatage = (): string => new Date(maintenant()).toISOString();

  // ——— File d'attente ———

  /** Ajoute en respectant la borne : on jette d'abord les plus vieux usages, puis sessions, jamais une erreur avant un usage. */
  function placer(entree: Entree, enTete = false): void {
    if (enTete) file.unshift(entree); else file.push(entree);
    while (file.length > max) {
      let plusBasse = Infinity;
      for (const e of file) plusBasse = Math.min(plusBasse, priorite(e.evenement));
      const index = file.findIndex((e) => priorite(e.evenement) === plusBasse);
      file.splice(index, 1);
    }
  }

  function masquerEvenement<T extends Evenement>(evenement: T): T {
    const masque = masquerValeur(evenement, optionsMasquage);
    // Les identifiants techniques ne doivent pas être pris pour des secrets.
    if ('id' in evenement) (masque as { id: string }).id = (evenement as { id: string }).id;
    if (evenement.type === 'erreur') {
      if (evenement.debugId) (masque as EvenementErreur).debugId = evenement.debugId;
      // Idem pour les identifiants de débogage des cadres : ils désignent une carte, pas une personne.
      evenement.exception.pile.forEach((cadre, i) => {
        const copie = (masque as EvenementErreur).exception.pile[i];
        if (cadre.debugId && copie) copie.debugId = cadre.debugId;
      });
    }
    return masque;
  }

  function ajouter(evenement: Evenement): void {
    placer({ evenement: masquerEvenement(evenement), contexte });
    if (file.length >= seuil) planifier(0);
  }

  // ——— Envoi ———

  function recul(): number {
    return Math.min(reculMaxMs, reculBaseMs * 2 ** Math.max(0, echecs - 1));
  }

  function planifier(delai: number): void {
    if (arrete || reglages.minuterie === false) return;
    try {
      if (minuterie) clearTimeout(minuterie);
      const attente = Math.max(delai, pauseJusqua - maintenant(), 0);
      minuterie = setTimeout(() => {
        minuterie = null;
        void vider().finally(() => planifier(intervalleMs));
      }, attente);
      // Côté Node : la minuterie ne doit pas garder le processus en vie.
      (minuterie as { unref?: () => void }).unref?.();
    } catch (err) {
      avertir('minuterie impossible', err);
    }
  }

  function enveloppe(lot: Entree[]): Envoi {
    return {
      version: VERSION_ENVOI,
      sdk: { nom: nomSdk, version: VERSION_SDK },
      contexte: lot[0].contexte,
      evenements: lot.map((e) => e.evenement)
    };
  }

  /** Retire de la file un lot de même contexte, sous les limites de nombre et de taille. Rend aussi son corps JSON. */
  function prendreLot(tailleMax: number): { lot: Entree[]; corps: string } | null {
    while (file.length) {
      const contexteLot = file[0].contexte;
      let n = 0;
      while (n < file.length && n < EVENEMENTS_MAX_PAR_ENVOI && file[n].contexte === contexteLot) n++;
      while (n >= 1) {
        const lot = file.slice(0, n);
        const corps = JSON.stringify(enveloppe(lot));
        if (tailleOctets(corps) <= tailleMax) {
          file.splice(0, n);
          return { lot, corps };
        }
        if (n === 1) break;
        n = Math.ceil(n / 2);
      }
      // Un seul événement trop gros : on l'abandonne plutôt que de bloquer la file.
      avertir('événement trop gros, abandonné');
      file.shift();
    }
    return null;
  }

  function remettre(lot: Entree[]): void {
    for (let i = lot.length - 1; i >= 0; i--) placer(lot[i], true);
  }

  async function boucle(): Promise<void> {
    while (file.length) {
      if (maintenant() < pauseJusqua) return;
      if (reglages.enLigne && !reglages.enLigne()) return;
      const pris = prendreLot(TAILLE_MAX_ENVOI);
      if (!pris) return;
      let statut = 0;
      let reessayerApres: string | null | undefined;
      try {
        const reponse = await transport({
          url: `${adresse}/v1/envoi`,
          entetes: { 'Content-Type': 'application/json', 'X-Centrale-Cle': config.cle },
          corps: pris.corps
        });
        statut = Number(reponse?.statut) || 0;
        reessayerApres = reponse?.reessayerApres;
      } catch (err) {
        avertir('envoi impossible (hors ligne ?)', err);
      }
      if (statut >= 200 && statut < 300) {
        echecs = 0;
        continue;
      }
      if (statut === 429) {
        echecs++;
        const demande = lireRetryAfter(reessayerApres, maintenant());
        pauseJusqua = maintenant() + (demande ?? recul());
        remettre(pris.lot);
        planifier(0);
        return;
      }
      if (statut >= 400 && statut < 500 && statut !== 408) {
        // 400, 401, 413 (et les autres 4xx) : réessayer ne changerait rien, on abandonne le lot.
        avertir(`lot refusé (${statut}), abandonné`);
        continue;
      }
      // 5xx, 408, ou aucune réponse : on garde le lot et on recule.
      echecs++;
      pauseJusqua = maintenant() + recul();
      remettre(pris.lot);
      planifier(0);
      return;
    }
  }

  function vider(): Promise<void> {
    try {
      if (!enCours) {
        enCours = boucle()
          .catch((err) => avertir('vidage interrompu', err))
          .finally(() => { enCours = null; });
      }
      return enCours;
    } catch (err) {
      avertir('vidage impossible', err);
      return Promise.resolve();
    }
  }

  // ——— Fil d'Ariane ———

  function filCourant(): Miette[] {
    try { return reglages.portee?.()?.miettes ?? miettes; } catch { return miettes; }
  }

  const sur = <A extends unknown[], R>(nom: string, fn: (...a: A) => R, defaut: R) => (...args: A): R => {
    try {
      return fn(...args);
    } catch (err) {
      avertir(`${nom} a échoué`, err);
      return defaut;
    }
  };

  const centrale: Centrale = {
    actif: true,
    config,

    erreur: sur('erreur', (e: unknown, extra: ExtraErreur = {}) => {
      const objet = (e && typeof e === 'object') ? e as { name?: unknown; message?: unknown; stack?: unknown; constructor?: { name?: unknown } } : undefined;
      const type = objet
        ? String(objet.name || objet.constructor?.name || 'Error')
        : (typeof e === 'string' ? 'Error' : 'ValeurLancee');
      const message = objet ? String(objet.message ?? '') : String(e);
      const pile = extra.pile ? extra.pile.map((c) => ({ ...c })) : analyserPile(objet?.stack, { racine: config.racine });
      let quand = horodatage();
      if (extra.horodatage) {
        const d = new Date(extra.horodatage);
        if (!Number.isNaN(d.getTime())) quand = d.toISOString();
      }
      const portee = reglages.portee?.();
      const evenement: EvenementErreur = {
        type: 'erreur',
        id: identifiant(aleatoire),
        horodatage: quand,
        niveau: extra.niveau ?? 'erreur',
        exception: { type: borner(type, 200), message: borner(message, MESSAGE_MAX), pile }
      };
      // Les identifiants posés par `centrale injecter` : un par cadre, et celui de l'erreur s'il n'y a qu'un fichier.
      const debugIdCommun = associerDebugIds(pile, { racine: config.racine });
      if (extra.debugId) evenement.debugId = extra.debugId;
      else if (debugIdCommun) evenement.debugId = debugIdCommun;
      const fil = extra.filAriane ?? filCourant();
      if (fil.length) evenement.filAriane = fil.slice(-MIETTES_MAX).map((m) => ({ ...m }));
      const requete = extra.requete ?? portee?.requete;
      if (requete) evenement.requete = { ...requete, route: gabaritAdresse(String(requete.route ?? '')) };
      if (extra.empreinte?.length) evenement.empreinte = extra.empreinte.map(String);
      if (extra.etiquettes) evenement.etiquettes = Object.fromEntries(Object.entries(extra.etiquettes).map(([k, v]) => [k, borner(String(v), TEXTE_PROPRIETE_MAX)]));
      if (contexte.sessionId) erreursSession++;
      ajouter(evenement);
      return evenement.id;
    }, undefined),

    vue: sur('vue', (nom: string, dureeChargementMs?: number) => {
      if (aleatoire() >= taux(config.echantillonnage?.vues)) return;
      const evenement: EvenementVue = { type: 'vue', horodatage: horodatage(), nom: gabaritAdresse(String(nom)) };
      if (typeof dureeChargementMs === 'number' && Number.isFinite(dureeChargementMs) && dureeChargementMs >= 0) {
        evenement.dureeChargementMs = Math.round(dureeChargementMs);
      }
      ajouter(evenement);
    }, undefined),

    usage: sur('usage', (nom: string, proprietes?: Record<string, unknown>) => {
      if (aleatoire() >= taux(config.echantillonnage?.usages)) return;
      const evenement: EvenementUsage = { type: 'usage', horodatage: horodatage(), nom: borner(String(nom), TEXTE_PROPRIETE_MAX) };
      const props = proprietesSimples(proprietes);
      if (props) evenement.proprietes = props;
      ajouter(evenement);
    }, undefined),

    ia: sur('ia', (infos: InfosIA) => {
      if (aleatoire() >= taux(config.echantillonnage?.ia)) return;
      // Liste blanche des champs : le contenu des messages ne peut pas passer, même par erreur.
      const evenement: EvenementIA = {
        type: 'ia',
        horodatage: horodatage(),
        fournisseur: borner(String(infos.fournisseur ?? 'inconnu'), 100),
        modele: borner(String(infos.modele ?? 'inconnu'), 100),
        dureeMs: Math.max(0, Math.round(Number(infos.dureeMs) || 0)),
        resultat: (['ok', 'erreur', 'quota', 'repli'] as const).includes(infos.resultat) ? infos.resultat : 'erreur'
      };
      for (const champ of ['jetonsEntree', 'jetonsSortie', 'jetonsCache'] as const) {
        const v = infos[champ];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) evenement[champ] = Math.round(v);
      }
      if (infos.outil) evenement.outil = borner(String(infos.outil), 100);
      ajouter(evenement);
    }, undefined),

    session: sur('session', (etat: EvenementSession['etat']) => {
      if (etat === 'debut') {
        const id = identifiant(aleatoire);
        contexte = { ...contexte, sessionId: id };
        debutSession = maintenant();
        erreursSession = 0;
        ajouter({ type: 'session', id, horodatage: horodatage(), etat: 'debut' });
        return;
      }
      const id = contexte.sessionId;
      if (!id) return;
      // Une session terminée « ok » après des erreurs compte comme « erreur ».
      const final = etat === 'ok' && erreursSession > 0 ? 'erreur' : etat;
      ajouter({ type: 'session', id, horodatage: horodatage(), etat: final, dureeMs: Math.max(0, maintenant() - debutSession) });
      const { sessionId: _ancienne, ...sansSession } = contexte;
      contexte = sansSession;
    }, undefined),

    miette: sur('miette', (categorie: Miette['categorie'], message: string, donnees?: Record<string, unknown>) => {
      const miette: Miette = {
        horodatage: horodatage(),
        categorie: (['navigation', 'requete', 'clic', 'console', 'autre'] as const).includes(categorie) ? categorie : 'autre',
        message: masquerTexte(borner(String(message), 500), optionsMasquage)
      };
      const props = proprietesSimples(donnees);
      if (props) miette.donnees = masquerValeur(props, optionsMasquage);
      const fil = filCourant();
      fil.push(miette);
      if (fil.length > MIETTES_MAX) fil.splice(0, fil.length - MIETTES_MAX);
    }, undefined),

    definirUtilisateur: sur('definirUtilisateur', (id: string | number | null | undefined) => {
      if (config.strict) return; // mode strict : jamais d'utilisateur
      if (id === null || id === undefined || id === '') {
        const { utilisateur: _ancien, ...sansUtilisateur } = contexte;
        contexte = sansUtilisateur;
        return;
      }
      if (!config.sel) avertir('aucun sel fourni : l\'empreinte d\'utilisateur est plus facile à retrouver');
      contexte = { ...contexte, utilisateur: sha256Hex(`${config.sel ?? ''}:${String(id)}`) };
    }, undefined),

    definirContexte: sur('definirContexte', (partiel: Partial<Omit<Contexte, 'utilisateur' | 'sessionId' | 'environnement'>>) => {
      const suivant: Record<string, unknown> = { ...contexte };
      for (const [cle, valeur] of Object.entries(partiel ?? {})) {
        if (cle === 'utilisateur' || cle === 'sessionId' || cle === 'environnement') continue;
        if (cle === 'appareil' && config.strict) continue;
        if (valeur === undefined || valeur === null || valeur === '') delete suivant[cle];
        else suivant[cle] = masquerTexte(String(valeur), optionsMasquage);
      }
      contexte = suivant as unknown as Contexte;
    }, undefined),

    vider,

    viderParBalise: sur('viderParBalise', (envoyer: (url: string, corps: string) => boolean, tailleMax = 60_000) => {
      if (maintenant() < pauseJusqua) return;
      const url = `${adresse}/v1/envoi?cle=${encodeURIComponent(config.cle)}`;
      while (file.length) {
        const pris = prendreLot(Math.min(tailleMax, TAILLE_MAX_ENVOI));
        if (!pris) return;
        let parti = false;
        try { parti = envoyer(url, pris.corps) === true; } catch (err) { avertir('balise impossible', err); }
        if (!parti) {
          remettre(pris.lot);
          return;
        }
      }
    }, undefined),

    arreter: sur('arreter', () => {
      arrete = true;
      if (minuterie) clearTimeout(minuterie);
      minuterie = null;
    }, undefined),

    enAttente: () => file.length,
    sessionCourante: () => contexte.sessionId,
    filAriane: () => filCourant().map((m) => ({ ...m })),
    sessionPrecedente: sur('sessionPrecedente', (id: string, etat: 'anormal' | 'plantage') => {
      if (!id || id === contexte.sessionId) return;
      ajouter({ type: 'session', id: borner(String(id), 100), horodatage: horodatage(), etat: etat === 'plantage' ? 'plantage' : 'anormal' });
    }, undefined)
  };

  planifier(intervalleMs);
  return centrale;
}
