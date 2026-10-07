/**
 * Les identifiants de débogage posés dans le build par `centrale injecter` (paquet
 * `@astratra/centrale-cli`). Chaque fichier injecté exécute au chargement :
 *   globalThis.__centraleDebugIds[new Error().stack] = "<debugId>"
 * La clé est une pile capturée DANS ce fichier : son premier cadre donne l'adresse exacte du
 * fichier telle que le moteur l'écrit dans les piles (hash du build, domaine, chemin compris).
 * On relit ces piles avec le même analyseur que les erreurs : un cadre d'erreur et la clé d'un
 * fichier donnent donc le même `fichier`, et l'association est exacte, sans deviner d'URL.
 */

import type { Cadre } from './envoi.ts';
import { analyserPile, type OptionsPile } from './pile.ts';

export const GLOBALE_DEBUG_IDS = '__centraleDebugIds';

let cache: { source: object; taille: number; racine: string | undefined; table: Map<string, string> } | null = null;

/** Fichier (tel qu'il apparaît dans les cadres) vers identifiant de débogage. Ne lève jamais. */
export function debugIdsParFichier(options: OptionsPile = {}): Map<string, string> {
  try {
    const source = (globalThis as Record<string, unknown>)[GLOBALE_DEBUG_IDS];
    if (!source || typeof source !== 'object') return new Map();
    const cles = Object.keys(source);
    // De nouveaux fichiers peuvent se charger plus tard (découpage du code) : on relit quand il y en a plus.
    if (cache && cache.source === source && cache.taille === cles.length && cache.racine === options.racine) return cache.table;
    const table = new Map<string, string>();
    for (const pile of cles) {
      const id = (source as Record<string, unknown>)[pile];
      if (typeof id !== 'string' || !id) continue;
      const premier = analyserPile(pile, options)[0];
      if (premier?.fichier && !table.has(premier.fichier)) table.set(premier.fichier, id);
    }
    cache = { source, taille: cles.length, racine: options.racine, table };
    return table;
  } catch {
    return new Map();
  }
}

/**
 * Ajoute à chaque cadre l'identifiant de son fichier. Rend l'identifiant commun s'il n'y en a
 * qu'un seul dans toute la pile (une erreur d'un seul fichier), pour `EvenementErreur.debugId`.
 */
export function associerDebugIds(pile: Cadre[], options: OptionsPile = {}): string | undefined {
  const table = debugIdsParFichier(options);
  if (!table.size) return undefined;
  const vus = new Set<string>();
  for (const cadre of pile) {
    const id = table.get(cadre.fichier);
    if (id) {
      cadre.debugId = id;
      vus.add(id);
    }
  }
  return vus.size === 1 ? [...vus][0] : undefined;
}
