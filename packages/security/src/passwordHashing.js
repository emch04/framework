const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const ALGORITHM = 'scrypt';
const DEFAULT_COST = 16384; // N — CPU/memory cost factor, must be a power of 2
const DEFAULT_BLOCK_SIZE = 8; // r
const DEFAULT_PARALLELIZATION = 1; // p
const SALT_LENGTH = 16;
const KEY_LENGTH = 64;

function scryptOptions(cost, blockSize, parallelization) {
  // Node's default maxmem (32MB) caps N*r*128 — pass an explicit maxmem so a
  // higher cost factor doesn't throw "Invalid options: N too large" for a
  // caller that reasonably wants extra hardening.
  return { N: cost, r: blockSize, p: parallelization, maxmem: 128 * cost * blockSize * 2 };
}

/**
 * Password hashing Astratra never had — verifyPassword was always a
 * callback the app supplies, and the framework offered no guidance on how
 * to hash in the first place. scrypt is a Node built-in memory-hard KDF
 * (no bcrypt/argon2 dependency to add), constant-time verified.
 *
 * const hash = await hashPassword('correct horse battery staple');
 * // store `hash` — it already carries its own salt and cost factor
 * const ok = await verifyPasswordHash('correct horse battery staple', hash);
 */
async function hashPassword(password, options = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword requires a non-empty string password.');
  }
  const cost = options.cost || DEFAULT_COST;
  const blockSize = options.blockSize || DEFAULT_BLOCK_SIZE;
  const parallelization = options.parallelization || DEFAULT_PARALLELIZATION;

  const salt = crypto.randomBytes(SALT_LENGTH);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, scryptOptions(cost, blockSize, parallelization));

  return [
    ALGORITHM,
    cost,
    blockSize,
    parallelization,
    salt.toString('base64url'),
    derivedKey.toString('base64url')
  ].join('$');
}

/**
 * Verifies a password against a hash produced by hashPassword(). Returns
 * false for a wrong password AND for a malformed/foreign hash — never
 * throws on bad input, so a caller can always treat a falsy result as
 * "reject the login" without a try/catch.
 */
async function verifyPasswordHash(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string') return false;

  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const [, costStr, blockSizeStr, parallelizationStr, saltB64, keyB64] = parts;
  const cost = Number(costStr);
  const blockSize = Number(blockSizeStr);
  const parallelization = Number(parallelizationStr);
  // Bounds match what hashPassword() would ever produce — a hash string
  // claiming a wildly larger cost/key length is malformed (or adversarial),
  // not a slower-but-valid hash, so reject before scrypt() allocates for it.
  if (!Number.isFinite(cost) || cost <= 0 || cost > 1 << 20) return false;
  if (!Number.isFinite(blockSize) || blockSize <= 0 || blockSize > 64) return false;
  if (!Number.isFinite(parallelization) || parallelization <= 0 || parallelization > 16) return false;

  let salt;
  let expectedKey;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expectedKey = Buffer.from(keyB64, 'base64url');
  } catch {
    return false;
  }
  if (expectedKey.length === 0 || expectedKey.length > 256) return false;

  const derivedKey = await scrypt(password, salt, expectedKey.length, scryptOptions(cost, blockSize, parallelization));
  return crypto.timingSafeEqual(derivedKey, expectedKey);
}

module.exports = {
  hashPassword,
  verifyPasswordHash
};
