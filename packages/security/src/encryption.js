const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

const normalizeKey = (key) => {
  if (Buffer.isBuffer(key)) {
    if (key.length !== KEY_LENGTH) {
      throw new Error(`createFieldCipher requires a ${KEY_LENGTH}-byte key, got ${key.length} bytes.`);
    }
    return key;
  }

  if (typeof key === 'string') {
    const base64Decoded = Buffer.from(key, 'base64');
    if (base64Decoded.length === KEY_LENGTH) return base64Decoded;
    const hexDecoded = Buffer.from(key, 'hex');
    if (hexDecoded.length === KEY_LENGTH) return hexDecoded;
    throw new Error(`createFieldCipher requires a ${KEY_LENGTH}-byte key encoded as base64 or hex (got a string that decodes to neither length).`);
  }

  throw new Error('createFieldCipher requires options.key as a Buffer or a base64/hex string.');
};

/**
 * Field-level encryption for values you write to a store yourself —
 * Astratra never touches your data on its way to a database, so nothing
 * upstream of this can encrypt it for you. AES-256-GCM, authenticated
 * (tamper-evident: a modified ciphertext or wrong key fails to decrypt
 * rather than silently returning garbage).
 *
 * Generate a key once: crypto.randomBytes(32).toString('base64'), store it
 * as a secret (env var), never in the repo. Rotating the key means old
 * ciphertexts become undecryptable — plan a re-encryption path if you
 * expect to rotate.
 *
 * const cipher = createFieldCipher({ key: process.env.FIELD_ENCRYPTION_KEY });
 * const stored = cipher.encrypt('4242-4242-4242-4242');  // single string, safe for any column/field
 * const plain = cipher.decrypt(stored);
 */
const createFieldCipher = (options = {}) => {
  const key = normalizeKey(options.key);

  return {
    encrypt(plaintext) {
      if (plaintext === null || plaintext === undefined) {
        throw new Error('createFieldCipher.encrypt requires a non-null value.');
      }
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return [iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join('.');
    },

    decrypt(payload) {
      const parts = String(payload || '').split('.');
      if (parts.length !== 3) {
        throw new Error('createFieldCipher.decrypt received a malformed payload.');
      }
      const [ivPart, authTagPart, ciphertextPart] = parts;
      const iv = Buffer.from(ivPart, 'base64url');
      const authTag = Buffer.from(authTagPart, 'base64url');
      const ciphertext = Buffer.from(ciphertextPart, 'base64url');

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    }
  };
};

const generateFieldEncryptionKey = () => crypto.randomBytes(KEY_LENGTH).toString('base64');

module.exports = {
  createFieldCipher,
  generateFieldEncryptionKey
};
