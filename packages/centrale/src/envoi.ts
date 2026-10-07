/**
 * Le format d'envoi de Centrale LJ : ce que les paquets de collecte envoient au backend.
 * C'est le contrat entre `paquets/centrale` (qui écrit) et `backend` (qui reçoit).
 * Aucune dépendance à Sentry : format propre, versionné par `version`.
 *
 * Requête : POST {adresse}/v1/envoi
 * - en-tête `X-Centrale-Cle: clj_pub_…` (ou `?cle=` dans l'adresse, pour `navigator.sendBeacon`) ;
 * - corps JSON, éventuellement compressé (`Content-Encoding: gzip`) ;
 * - au plus TAILLE_MAX_ENVOI octets une fois décompressé, au plus EVENEMENTS_MAX_PAR_ENVOI événements.
 * Réponses : 202 { recus }, 400 format invalide, 401 clé inconnue ou révoquée,
 * 413 trop gros, 429 trop d'envois (en-tête `Retry-After` en secondes).
 */

export const VERSION_ENVOI = 1;
export const TAILLE_MAX_ENVOI = 1024 * 1024;
export const EVENEMENTS_MAX_PAR_ENVOI = 100;
export const MIETTES_MAX = 50;
export const CADRES_MAX = 100;

export type Niveau = 'fatal' | 'erreur' | 'avertissement';

/** Une ligne de pile d'appels. `app` : vrai si le fichier appartient au projet (pas une dépendance). */
export interface Cadre {
  fichier: string;
  fonction?: string;
  ligne?: number;
  colonne?: number;
  app: boolean;
  /**
   * Identifiant de débogage du fichier (posé dans le build par `centrale injecter`) : il désigne
   * la carte de code qui traduit ce cadre. Optionnel et ajouté après coup : un envoi sans lui reste valide.
   */
  debugId?: string;
}

/**
 * Un cadre tel que le backend le rend dans le détail d'un problème, une fois traduit par la
 * carte de code : `fichier`, `ligne`, `colonne` et `fonction` sont ceux du code d'origine,
 * `minifie` garde la position reçue, et `code` quelques lignes autour si la carte contient le source.
 */
export interface CadreSymbolise extends Cadre {
  symbolise?: true;
  minifie?: { fichier: string; fonction?: string; ligne?: number; colonne?: number };
  /** `lignes[0]` est la ligne numéro `premiere` du fichier d'origine. */
  code?: { premiere: number; lignes: string[] };
}

/** Une action récente avant l'erreur (fil d'Ariane), déjà masquée. */
export interface Miette {
  horodatage: string;
  categorie: 'navigation' | 'requete' | 'clic' | 'console' | 'autre';
  message: string;
  donnees?: Record<string, string | number | boolean>;
}

export interface EvenementErreur {
  type: 'erreur';
  id: string;
  horodatage: string;
  niveau: Niveau;
  exception: { type: string; message: string; pile: Cadre[] };
  /** Identifiant de la carte de code (source map, dSYM) qui permet de retrouver la vraie ligne. */
  debugId?: string;
  filAriane?: Miette[];
  /** Côté serveur : la requête pendant laquelle l'erreur est arrivée. */
  requete?: { methode: string; route: string; statut?: number; dureeMs?: number; idRequete?: string };
  /** Empreinte imposée par le projet, si le regroupement automatique ne convient pas. */
  empreinte?: string[];
  etiquettes?: Record<string, string>;
}

/** Début ou fin de session, pour le taux de sessions sans plantage. Jamais échantillonné. */
export interface EvenementSession {
  type: 'session';
  id: string;
  horodatage: string;
  etat: 'debut' | 'ok' | 'erreur' | 'plantage' | 'anormal';
  dureeMs?: number;
}

/** Une page ou un écran vu. `nom` est un gabarit (`/eleve/:id`), jamais une adresse avec identifiants. */
export interface EvenementVue {
  type: 'vue';
  horodatage: string;
  nom: string;
  dureeChargementMs?: number;
}

/** Une fonction ou un outil utilisé, avec des propriétés simples (liste blanche, jamais de texte libre). */
export interface EvenementUsage {
  type: 'usage';
  horodatage: string;
  nom: string;
  proprietes?: Record<string, string | number | boolean>;
}

/** Un appel à un modèle d'IA. Jamais le contenu des messages. */
export interface EvenementIA {
  type: 'ia';
  horodatage: string;
  fournisseur: string;
  modele: string;
  dureeMs: number;
  jetonsEntree?: number;
  jetonsSortie?: number;
  jetonsCache?: number;
  resultat: 'ok' | 'erreur' | 'quota' | 'repli';
  outil?: string;
}

export type Evenement = EvenementErreur | EvenementSession | EvenementVue | EvenementUsage | EvenementIA;

export interface Contexte {
  environnement: 'production' | 'preproduction' | 'developpement';
  /** Version de l'app ou du serveur, par exemple « 2.14.0 ». */
  version?: string;
  build?: string;
  /** Identifiant de la mise à jour à distance (Expo), s'il y en a une. */
  miseAJour?: string;
  plateforme: 'serveur' | 'web' | 'ios' | 'android' | 'bureau';
  os?: string;
  appareil?: string;
  langue?: string;
  sessionId?: string;
  /** Identifiant d'utilisateur déjà haché avec le sel du projet. Jamais l'identifiant brut. */
  utilisateur?: string;
}

export interface Envoi {
  version: typeof VERSION_ENVOI;
  sdk: { nom: string; version: string };
  contexte: Contexte;
  evenements: Evenement[];
}
