/**
 * Le codage VLQ en base 64 des cartes de code (source maps, version 3), réduit à ce dont
 * l'injection a besoin : décaler les colonnes d'une ligne générée quand on y insère du code.
 * Sans dépendance. Le backend a son propre décodeur complet (backend/src/modules/carteCode.ts).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALEURS = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

/** Lit une valeur VLQ à partir de `debut` ; rend la valeur et la position qui suit. */
export function lireVlq(texte: string, debut: number): [number, number] {
  let resultat = 0;
  let decalage = 0;
  let i = debut;
  for (;;) {
    if (i >= texte.length) throw new Error('VLQ tronqué');
    const chiffre = VALEURS.get(texte[i++]);
    if (chiffre === undefined) throw new Error('VLQ invalide');
    resultat += (chiffre & 31) * 2 ** decalage;
    decalage += 5;
    if (!(chiffre & 32)) break;
    if (decalage > 35) throw new Error('VLQ trop long');
  }
  const negatif = resultat % 2 === 1;
  const valeur = Math.floor(resultat / 2);
  return [negatif ? -valeur : valeur, i];
}

export function ecrireVlq(valeur: number): string {
  let reste = valeur < 0 ? (-valeur) * 2 + 1 : valeur * 2;
  let sortie = '';
  do {
    let chiffre = reste & 31;
    reste = Math.floor(reste / 32);
    if (reste > 0) chiffre |= 32;
    sortie += ALPHABET[chiffre];
  } while (reste > 0);
  return sortie;
}

/**
 * Décale de `longueur` les segments de la ligne générée `ligne` (0 = première) situés à la
 * colonne `colonne` ou après. Dans une ligne, seule la première colonne est absolue, les
 * suivantes sont relatives : il suffit donc de corriger le premier segment concerné.
 */
export function decalerColonnes(mappings: string, ligne: number, colonne: number, longueur: number): string {
  const lignes = mappings.split(';');
  if (ligne >= lignes.length || !lignes[ligne]) return mappings;
  const segments = lignes[ligne].split(',');
  let absolue = 0;
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i]) continue;
    const [delta, fin] = lireVlq(segments[i], 0);
    absolue += delta;
    if (absolue >= colonne) {
      segments[i] = ecrireVlq(delta + longueur) + segments[i].slice(fin);
      break;
    }
  }
  lignes[ligne] = segments.join(',');
  return lignes.join(';');
}
