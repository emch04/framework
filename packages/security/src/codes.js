const crypto = require('crypto');

const DEFAULT_TOKEN_BYTES = 5;

// Aucune notion métier ici (promo, invitation, carte cadeau...) : le préfixe
// et l'usage du code sont entièrement définis par le projet consommateur.
const createRandomCode = ({ prefix, tokenBytes = DEFAULT_TOKEN_BYTES } = {}) => {
  const safePrefix = String(prefix || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const token = crypto.randomBytes(tokenBytes).toString('hex').toUpperCase();
  return safePrefix ? `${safePrefix}-${token}` : token;
};

/**
 * Génère `quantity` codes garantis uniques entre eux ET, si `isTaken` est
 * fourni, absents de ton propre store — vérifiés AVANT tout retour, jamais
 * après une tentative d'insertion. Une collision avec `crypto.randomBytes`
 * est déjà astronomiquement improbable ; ce garde-fou ne fait qu'éviter de
 * planter sur ce cas rarissime plutôt que de le rendre plus probable.
 *
 * `isTaken(candidates)` reçoit un tableau de codes candidats et doit
 * renvoyer une Promise<Set<string>> (ou tout ce qui expose `.has()`) des
 * codes parmi eux déjà pris — à toi de l'implémenter contre ton propre
 * store (Mongo, Postgres, mémoire...).
 */
const generateUniqueCodes = async ({ quantity, prefix, tokenBytes, isTaken, maxAttempts = 5 } = {}) => {
  const unique = new Set();
  for (let attempt = 1; attempt <= maxAttempts && unique.size < quantity; attempt++) {
    const missing = quantity - unique.size;
    const candidates = new Set();
    while (candidates.size < missing) {
      const code = createRandomCode({ prefix, tokenBytes });
      if (!unique.has(code)) candidates.add(code);
    }
    const taken = isTaken ? await isTaken([...candidates]) : null;
    for (const code of candidates) {
      if (!taken || !taken.has(code)) unique.add(code);
    }
  }
  if (unique.size < quantity) {
    throw new Error('Unable to generate enough unique codes after multiple attempts');
  }
  return [...unique];
};

module.exports = { createRandomCode, generateUniqueCodes };
