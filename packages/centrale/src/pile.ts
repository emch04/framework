/**
 * Lecture des piles d'appels, sans dépendance : V8 (Node, Chrome, Edge), Hermes
 * (React Native), JavaScriptCore (Safari) et SpiderMonkey (Firefox).
 * Chaque cadre est marqué `app: false` s'il vient d'une dépendance ou du moteur.
 * L'ordre est celui de la pile : l'appel le plus récent en premier.
 */

import type { Cadre } from './envoi.ts';
import { CADRES_MAX } from './envoi.ts';

export interface OptionsPile {
  /** Préfixe retiré des chemins (racine du projet), pour des chemins courts et sans nom d'utilisateur. */
  racine?: string;
}

const LIGNE_V8 = /^\s*at\s+/;

/** Vrai si le fichier appartient au projet (ni dépendance, ni code interne du moteur ou du navigateur). */
export function estFichierApp(fichier: string): boolean {
  if (!fichier) return false;
  if (/(^|[\\/])node_modules[\\/]/.test(fichier)) return false;
  if (/^(node:|internal[\\/]|native\b|\[native code\]|<anonymous>|<unknown>|<interne>|unknown$|anonymous$)/.test(fichier)) return false;
  if (/^(chrome|moz|safari(-web)?|ms-browser)-extension:/.test(fichier)) return false;
  if (/^webkit-masked-url:/.test(fichier)) return false;
  return true;
}

/** Sépare « fichier:ligne:colonne », sachant que le fichier peut contenir des « : » (https://, C:\). */
function separerPosition(emplacement: string): { fichier: string; ligne?: number; colonne?: number } {
  const complet = /^(.*):(\d+):(\d+)$/.exec(emplacement);
  if (complet) return { fichier: complet[1], ligne: Number(complet[2]), colonne: Number(complet[3]) };
  const ligneSeule = /^(.*):(\d+)$/.exec(emplacement);
  if (ligneSeule) return { fichier: ligneSeule[1], ligne: Number(ligneSeule[2]) };
  return { fichier: emplacement };
}

function nettoyerFichier(fichier: string, options: OptionsPile): string {
  let f = fichier.trim();
  if (f.startsWith('address at ')) f = f.slice('address at '.length); // Hermes
  // Les adresses web perdent leur chaîne de requête et leur fragment (jetons possibles).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(f)) f = f.replace(/[?#].*$/, '');
  const racine = options.racine?.replace(/[\\/]+$/, '');
  if (racine) {
    for (const prefixe of [`file://${racine}`, racine]) {
      if (f.startsWith(prefixe + '/') || f.startsWith(prefixe + '\\')) {
        f = f.slice(prefixe.length + 1);
        break;
      }
    }
  }
  return f;
}

function nettoyerFonction(fonction: string | undefined): string | undefined {
  if (!fonction) return undefined;
  const f = fonction.replace(/^async\s+/, '').trim();
  if (!f || f === '<anonymous>' || f === 'anonymous') return undefined;
  return f;
}

function cadre(fonction: string | undefined, emplacement: string, options: OptionsPile): Cadre {
  const { fichier, ligne, colonne } = separerPosition(emplacement.trim());
  const brut = fichier.trim();
  const propre = nettoyerFichier(brut, options);
  // `app` est décidé sur le chemin brut : un chemin raccourci ne doit pas devenir « du projet ».
  const resultat: Cadre = { fichier: propre || '<inconnu>', app: estFichierApp(brut.replace(/^address at /, '')) };
  const nom = nettoyerFonction(fonction);
  if (nom) resultat.fonction = nom;
  if (ligne !== undefined) resultat.ligne = ligne;
  if (colonne !== undefined) resultat.colonne = colonne;
  return resultat;
}

/** Une ligne au format V8 / Hermes : « at fonction (fichier:1:2) » ou « at fichier:1:2 ». */
function lireLigneV8(ligne: string, options: OptionsPile): Cadre | null {
  const reste = ligne.replace(LIGNE_V8, '').trim();
  if (!reste) return null;
  let fonction: string | undefined;
  let emplacement = reste;
  const ouvrante = reste.indexOf(' (');
  if (reste.endsWith(')') && ouvrante > 0) {
    fonction = reste.slice(0, ouvrante);
    emplacement = reste.slice(ouvrante + 2, -1);
  } else if (reste.startsWith('(') && reste.endsWith(')')) {
    emplacement = reste.slice(1, -1);
  }
  // « eval at f (fichier:1:2), <anonymous>:3:4 » : on garde le fichier qui contient l'eval.
  if (emplacement.startsWith('eval at ')) {
    const interne = /\(([^()]*?:\d+:\d+)\)/.exec(emplacement);
    emplacement = interne ? interne[1] : '<anonymous>';
  }
  // « at async Promise.all (index 0) » : pas un fichier, c'est le moteur.
  if (/^index \d+$/.test(emplacement)) return cadre(fonction, '<interne>', options);
  return cadre(fonction, emplacement, options);
}

/** Une ligne au format JavaScriptCore / SpiderMonkey : « fonction@fichier:1:2 ». */
function lireLigneGecko(ligne: string, options: OptionsPile): Cadre | null {
  const texte = ligne.trim();
  if (!texte) return null;
  const arobase = texte.indexOf('@');
  if (arobase === -1) {
    // Safari écrit parfois « [native code] » ou « global code » sans emplacement.
    if (texte === '[native code]') return cadre(undefined, '[native code]', options);
    return null;
  }
  const fonction = texte.slice(0, arobase);
  const emplacement = texte.slice(arobase + 1);
  return cadre(fonction, emplacement || '<inconnu>', options);
}

/** Transforme `error.stack` en cadres, au plus CADRES_MAX. Ne lève jamais. */
export function analyserPile(pile: unknown, options: OptionsPile = {}): Cadre[] {
  if (typeof pile !== 'string' || !pile) return [];
  try {
    const lignes = pile.split('\n');
    const formatV8 = lignes.some((l) => LIGNE_V8.test(l));
    const cadres: Cadre[] = [];
    for (const ligne of lignes) {
      if (cadres.length >= CADRES_MAX) break;
      const c = formatV8
        ? (LIGNE_V8.test(ligne) ? lireLigneV8(ligne, options) : null)
        : lireLigneGecko(ligne, options);
      if (c) cadres.push(c);
    }
    return cadres;
  } catch {
    return [];
  }
}
