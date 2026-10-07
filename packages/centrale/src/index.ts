/**
 * `@astratra/centrale` : le cœur, utilisable partout (Node, navigateur, React Native).
 * Les points d'entrée `/node`, `/navigateur`, `/expo` et `/ia` le branchent sur leur plateforme.
 */

export {
  creerCentrale, centraleParDefaut, definirCentraleParDefaut,
  NOM_SDK, VERSION_SDK, FILE_MAX, SEUIL_LOT, INTERVALLE_MS, RECUL_BASE_MS, RECUL_MAX_MS
} from './coeur.ts';
export type { Centrale, ConfigCentrale, ExtraErreur, InfosIA, PorteeCentrale, ReglagesInternes } from './coeur.ts';
export { transportFetch, lireRetryAfter } from './transport.ts';
export type { Transport, RequeteTransport, ReponseTransport } from './transport.ts';
export { analyserPile, estFichierApp } from './pile.ts';
export { associerDebugIds, debugIdsParFichier, GLOBALE_DEBUG_IDS } from './debugIds.ts';
export { sha256Hex } from './sha256.ts';
export type {
  Cadre, CadreSymbolise, Contexte, Envoi, Evenement, EvenementErreur, EvenementIA, EvenementSession, EvenementUsage, EvenementVue, Miette, Niveau
} from './envoi.ts';
