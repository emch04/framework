/** `@astratra/centrale-cli` utilisé comme bibliothèque (scripts de build, tests). */
export { injecterDossier, injecterFichier, marquerCarteSeule, debugIdDe, ligneEnregistrement, pointDInsertion, GLOBALE } from './injecter.ts';
export type { Resultat } from './injecter.ts';
export { envoyerCartes, declarerDeploiement, cartesDe, appeler, ErreurCentrale, LOT_OCTETS, LOT_MAX_OCTETS } from './envoyer.ts';
export type { Connexion, CarteLocale, BilanEnvoi, Deploiement } from './envoyer.ts';
export { executer } from './cli.ts';
