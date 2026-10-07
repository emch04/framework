/**
 * `centrale injecter <dossier>` : donne à chaque fichier JavaScript d'un build un identifiant
 * de débogage (debug ID) stable, et l'écrit à trois endroits :
 * 1. dans le JavaScript, une ligne d'enregistrement exécutée au chargement du fichier :
 *    `globalThis.__centraleDebugIds[new Error().stack] = "<id>"`. La pile capturée commence
 *    par l'adresse du fichier tel que le navigateur, Node ou Hermes le voit vraiment ; le paquet
 *    de collecte relit ces piles et sait ainsi quel fichier (adresse finale, hash compris)
 *    porte quel identifiant, sans rien supposer du serveur web ni du nom des fichiers ;
 * 2. à la fin du JavaScript, le commentaire `//# debugId=<id>` (lisible par un humain et par les outils) ;
 * 3. dans la carte (.map), les champs `debug_id` et `debugId`.
 *
 * L'identifiant est dérivé du contenu (SHA-256 tronqué mis en forme d'UUID) : le même build
 * donne le même identifiant, et relancer la commande ne change rien (idempotence).
 *
 * La ligne d'enregistrement est insérée au DÉBUT du fichier (après un éventuel `#!` et les
 * directives comme "use strict" ou "use client", qui doivent rester en tête), SUR LA MÊME
 * LIGNE : les numéros de ligne ne bougent pas, seules les colonnes de cette ligne sont décalées
 * dans la carte. En tête, elle s'exécute avant tout le code du fichier : même une erreur levée
 * au chargement est reliée à sa carte.
 *
 * Les fichiers qui ne sont pas du JavaScript texte (bytecode Hermes `.hbc`) ne peuvent pas
 * recevoir cette ligne : leur carte reçoit quand même un identifiant, et le backend les retrouve
 * par la version et le nom du fichier.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { decalerColonnes } from './vlq.ts';

export const GLOBALE = '__centraleDebugIds';
const COMMENTAIRE = /\/\/# debugId=([0-9a-fA-F-]{36})\s*$/m;
const EXTENSIONS_JS = /\.(?:m|c)?js$/;
const DOSSIERS_IGNORES = new Set(['node_modules', '.git']);

export type Resultat =
  | { fichier: string; carte: string; debugId: string; etat: 'injecte' | 'deja' }
  | { fichier: string; carte: string; debugId: string; etat: 'carte-seule' }
  | { fichier: string; etat: 'sans-carte' };

/** Un identifiant au format UUID (version 4, variante RFC 4122) tiré d'un SHA-256 : stable pour un même contenu. */
export function debugIdDe(contenu: string | Buffer): string {
  const octets = createHash('sha256').update(contenu).digest().subarray(0, 16);
  octets[6] = (octets[6] & 0x0f) | 0x40;
  octets[8] = (octets[8] & 0x3f) | 0x80;
  const h = octets.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** La ligne d'enregistrement. Ne lève jamais, même dans un moteur sans `globalThis`. */
export function ligneEnregistrement(debugId: string): string {
  return `;!function(){try{var g=typeof globalThis!="undefined"?globalThis:typeof self!="undefined"?self:typeof window!="undefined"?window:typeof global!="undefined"?global:{},s=(new g.Error).stack;if(s){g.${GLOBALE}=g.${GLOBALE}||{};g.${GLOBALE}[s]="${debugId}"}}catch(e){}}();`;
}

/** Tous les fichiers d'un dossier, récursivement, sans node_modules ni .git. */
export function fichiersDe(dossier: string): string[] {
  const sortie: string[] = [];
  const parcourir = (d: string) => {
    for (const entree of readdirSync(d, { withFileTypes: true })) {
      if (entree.isDirectory()) {
        if (!DOSSIERS_IGNORES.has(entree.name)) parcourir(join(d, entree.name));
      } else if (entree.isFile()) {
        sortie.push(join(d, entree.name));
      }
    }
  };
  parcourir(dossier);
  return sortie.sort();
}

/** La carte d'un fichier JS : celle de son commentaire `sourceMappingURL` (si locale), sinon `<fichier>.map`. */
export function carteDe(fichierJs: string, contenu: string): string | null {
  const commentaires = [...contenu.matchAll(/\/\/[#@] sourceMappingURL=(\S+)\s*$/gm)];
  const adresse = commentaires.at(-1)?.[1];
  if (adresse && !/^[a-z]+:/i.test(adresse)) {
    let chemin: string;
    try { chemin = resolve(dirname(fichierJs), decodeURIComponent(adresse.split(/[?#]/)[0])); } catch { chemin = ''; }
    if (chemin && existsSync(chemin) && statSync(chemin).isFile()) return chemin;
  }
  const voisine = `${fichierJs}.map`;
  return existsSync(voisine) ? voisine : null;
}

/**
 * Où insérer la ligne d'enregistrement : après un `#!` et après les directives de tête
 * ("use strict", "use client"…), commentaires compris. Rend l'indice dans le texte.
 */
export function pointDInsertion(code: string): number {
  let i = 0;
  if (code.startsWith('#!')) {
    const fin = code.indexOf('\n');
    i = fin === -1 ? code.length : fin + 1;
  }
  const depart = i;
  let apresDirectives = -1;
  const blanc = /\s/;
  for (;;) {
    while (i < code.length && blanc.test(code[i])) i++;
    if (code.startsWith('//', i)) {
      const fin = code.indexOf('\n', i);
      i = fin === -1 ? code.length : fin + 1;
      continue;
    }
    if (code.startsWith('/*', i)) {
      const fin = code.indexOf('*/', i + 2);
      if (fin === -1) break;
      i = fin + 2;
      continue;
    }
    const directive = /^(['"])(?:[^'"\\\n]|\\.)*\1/.exec(code.slice(i, i + 500));
    if (!directive) break;
    let j = i + directive[0].length;
    while (code[j] === ' ' || code[j] === '\t') j++;
    // Une chaîne suivie d'autre chose qu'un « ; » ou une fin de ligne (`"a" + b`) n'est pas une directive.
    if (code[j] === ';') j++;
    else if (j < code.length && code[j] !== '\n' && code[j] !== '\r') break;
    i = j;
    apresDirectives = i;
  }
  return apresDirectives === -1 ? depart : apresDirectives;
}

/** Ligne et colonne (à partir de 0) d'un indice dans un texte. */
function positionDe(texte: string, indice: number): { ligne: number; colonne: number } {
  let ligne = 0;
  let debutLigne = 0;
  for (let i = 0; i < indice; i++) {
    if (texte.charCodeAt(i) === 10) { ligne++; debutLigne = i + 1; }
  }
  return { ligne, colonne: indice - debutLigne };
}

interface CarteJson { mappings?: unknown; debug_id?: unknown; debugId?: unknown; [cle: string]: unknown }

function lireCarte(chemin: string): CarteJson {
  const valeur = JSON.parse(readFileSync(chemin, 'utf8')) as unknown;
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) throw new Error(`carte illisible : ${chemin}`);
  return valeur as CarteJson;
}

/** Écrit l'identifiant dans la carte (`debug_id` et `debugId`) si besoin ; `decaler` corrige les colonnes. */
function marquerCarte(chemin: string, debugId: string, decaler?: { ligne: number; colonne: number; longueur: number }): void {
  const carte = lireCarte(chemin);
  if (carte.debug_id === debugId && carte.debugId === debugId && !decaler) return;
  if (decaler && typeof carte.mappings === 'string') {
    carte.mappings = decalerColonnes(carte.mappings, decaler.ligne, decaler.colonne, decaler.longueur);
  }
  carte.debug_id = debugId;
  carte.debugId = debugId;
  writeFileSync(chemin, JSON.stringify(carte));
}

/** Traite un fichier JavaScript et sa carte. Sans danger à relancer. */
export function injecterFichier(fichierJs: string): Resultat {
  const code = readFileSync(fichierJs, 'utf8');
  const carte = carteDe(fichierJs, code);
  if (!carte) return { fichier: fichierJs, etat: 'sans-carte' };

  const deja = COMMENTAIRE.exec(code);
  if (deja && code.includes(GLOBALE)) {
    const debugId = deja[1].toLowerCase();
    marquerCarte(carte, debugId);
    return { fichier: fichierJs, carte, debugId, etat: 'deja' };
  }

  const debugId = debugIdDe(code);
  const ligne = ligneEnregistrement(debugId);
  const indice = pointDInsertion(code);
  const position = positionDe(code, indice);
  const avecFinDeLigne = code.endsWith('\n') ? code : code + '\n';
  const nouveau = avecFinDeLigne.slice(0, indice) + ligne + avecFinDeLigne.slice(indice) + `//# debugId=${debugId}\n`;
  // La carte d'abord : si elle est illisible, le JavaScript reste intact.
  marquerCarte(carte, debugId, { ...position, longueur: ligne.length });
  writeFileSync(fichierJs, nouveau);
  return { fichier: fichierJs, carte, debugId, etat: 'injecte' };
}

/** Une carte sans JavaScript texte à côté (bytecode Hermes…) : seulement l'identifiant, tiré de son contenu. */
export function marquerCarteSeule(cheminCarte: string): Resultat {
  const carte = lireCarte(cheminCarte);
  const existant = typeof carte.debug_id === 'string' ? carte.debug_id : typeof carte.debugId === 'string' ? carte.debugId : null;
  const { debug_id: _a, debugId: _b, ...sansId } = carte;
  const debugId = existant ?? debugIdDe(JSON.stringify(sansId));
  marquerCarte(cheminCarte, debugId);
  return { fichier: cheminCarte.replace(/\.map$/, ''), carte: cheminCarte, debugId, etat: 'carte-seule' };
}

/** Tout un dossier de build : les JS avec carte, puis les cartes restées seules. */
export function injecterDossier(dossier: string): Resultat[] {
  const tous = fichiersDe(dossier);
  const resultats: Resultat[] = [];
  const cartesTraitees = new Set<string>();
  for (const f of tous.filter((f) => EXTENSIONS_JS.test(f))) {
    const r = injecterFichier(f);
    resultats.push(r);
    if ('carte' in r) cartesTraitees.add(resolve(r.carte));
  }
  for (const c of tous.filter((f) => f.endsWith('.map') && !cartesTraitees.has(resolve(f)))) {
    // Une carte de CSS n'a rien à faire ici.
    if (/\.css\.map$/.test(c)) continue;
    resultats.push(marquerCarteSeule(c));
  }
  return resultats;
}

/** Chemin relatif lisible, avec des « / » partout. */
export function cheminRelatif(dossier: string, fichier: string): string {
  return relative(dossier, fichier).split(sep).join('/') || basename(fichier);
}
