/**
 * Le masquage des données sensibles, appliqué deux fois : dans le paquet de collecte
 * avant tout envoi, puis par le backend à la réception. Sans dépendance (le paquet
 * de collecte le copie au moment de sa construction).
 */

const REGLES: Array<[RegExp, string]> = [
  /* Segments bornés : sans bornes, une suite « eyJ-eyJ-… » faisait reprendre la recherche à chaque
     départ possible, en temps quadratique (9 octobre 2026). */
  [/\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}/g, '[jeton]'],
  [/\b(Bearer|Basic)\s{1,8}[A-Za-z0-9._~+/=-]{8,8192}/gi, '$1 [jeton]'],
  [/\b(clj_(?:pub|dep|srv)_|sk-(?:proj-|ant-)?|gsk_|xaat-|AIza|ghp_|github_pat_|xox[bp]-|AKIA)[A-Za-z0-9_-]{8,512}/g, '[cle]'],
  [/\b(password|passwd|mot_?de_?passe|secret|token|api[_-]?key|authorization|cookie)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1$2[masque]'],
  /* Bornée (64 avant l'arobase, 255 après, comme la norme) : sans bornes, une longue chaîne sans
     « @ » faisait reprendre la recherche à chaque position, en temps quadratique, assez pour figer
     un serveur avec quelques envois. */
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g, '[email]'],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, '[iban]'],
  [/\b[a-f0-9]{32,}\b/gi, '[empreinte]']
];

/** Cartes bancaires : 13 à 19 chiffres (espaces ou tirets permis) qui passent la clé de Luhn. */
function masquerCartes(texte: string): string {
  return texte.replace(/(?<!\d)\d{4}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?(?!\d)/g, (bloc) => {
    const chiffres = bloc.replace(/\D/g, '');
    let somme = 0;
    for (let i = 0; i < chiffres.length; i++) {
      let n = Number(chiffres[chiffres.length - 1 - i]);
      if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
      somme += n;
    }
    return somme % 10 === 0 ? '[carte]' : bloc;
  });
}

/** Téléphones : 9 à 15 chiffres avec un + ou des séparateurs, en laissant les dates et les heures. */
function masquerTelephones(texte: string): string {
  return texte.replace(/(?<![\w.:/-])\+?\d[\d .()-]{7,18}\d(?![\w:/-])/g, (bloc) => {
    const chiffres = bloc.replace(/\D/g, '');
    if (chiffres.length < 9 || chiffres.length > 15) return bloc;
    if (/^\d{4}-\d{2}-\d{2}/.test(bloc) || /^\d{2}[./-]\d{2}[./-]\d{2,4}$/.test(bloc.trim())) return bloc;
    return '[telephone]';
  });
}

export interface OptionsMasquage {
  /** Des noms propres à masquer, fournis par le projet (élèves, clients…). */
  noms?: string[];
}

export function masquerTexte(texte: string, options: OptionsMasquage = {}): string {
  let resultat = texte;
  for (const [motif, remplacement] of REGLES) {
    // Sans arobase, aucune adresse e-mail possible : on évite même le parcours.
    if (remplacement === '[email]' && !resultat.includes('@')) continue;
    resultat = resultat.replace(motif, remplacement);
  }
  resultat = masquerCartes(resultat);
  resultat = masquerTelephones(resultat);
  for (const nom of options.noms ?? []) {
    if (nom.trim().length < 2) continue;
    const echappe = nom.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    resultat = resultat.replace(new RegExp(`\\b${echappe}\\b`, 'gi'), '[nom]');
  }
  return resultat;
}

/** Masque toutes les chaînes d'une valeur (objet, tableau), sans toucher à sa forme. */
export function masquerValeur<T>(valeur: T, options: OptionsMasquage = {}): T {
  if (typeof valeur === 'string') return masquerTexte(valeur, options) as T;
  if (Array.isArray(valeur)) return valeur.map((v) => masquerValeur(v, options)) as T;
  if (valeur && typeof valeur === 'object') {
    const copie: Record<string, unknown> = {};
    for (const [cle, v] of Object.entries(valeur)) {
      copie[cle] = /^(password|mot_?de_?passe|secret|token|authorization|cookie|api[_-]?key)$/i.test(cle) ? '[masque]' : masquerValeur(v, options);
    }
    return copie as T;
  }
  return valeur;
}

/**
 * Une adresse ramenée à son gabarit : sans chaîne de requête (sauf utm_*), sans fragment,
 * et les identifiants des chemins remplacés par `:id`. `/eleve/123?token=x` devient `/eleve/:id`.
 */
export function gabaritAdresse(adresse: string): string {
  const [avantFragment] = adresse.split('#');
  const [chemin, requete] = avantFragment.split('?');
  const gabarit = chemin
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) || /^[0-9a-f]{24}$/i.test(segment) || /^[A-Za-z0-9_-]{20,}$/.test(segment)
        ? ':id'
        : segment)
    .join('/');
  const utm = (requete ?? '').split('&').filter((p) => /^utm_[a-z]+=/i.test(p));
  return utm.length ? `${gabarit}?${utm.join('&')}` : gabarit;
}

/**
 * Les adresses IP (v4, et v6 avec « :: » ou ses huit groupes) remplacées par `[ip]`. À part de
 * masquerTexte : utile pour les journaux des serveurs (nginx écrit l'adresse de chaque client),
 * sans changer ce que le paquet de collecte masque déjà.
 */
export function masquerIP(texte: string): string {
  return texte
    .replace(/(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.]*\d)/g, '[ip]')
    .replace(/(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g, '[ip]')
    .replace(/(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?![0-9A-Fa-f:])/g, (bloc) => (bloc === '::' ? bloc : '[ip]'));
}
