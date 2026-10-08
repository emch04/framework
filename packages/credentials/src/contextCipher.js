const crypto = require('crypto');
const { contextBytes } = require('./context');

/** AES-256-GCM with a mandatory, externally supplied authenticated context. */
function createContextCipher({ key } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte Buffer key is required.');
  const material = Buffer.from(key);
  return {
    encrypt(plaintext, context) {
      const aad = contextBytes(context);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', material, iv);
      cipher.setAAD(aad);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    },
    decrypt(payload, context) {
      try {
        const aad = contextBytes(context);
        const parsed = JSON.parse(payload);
        function decode(value, length) {
          if (typeof value !== 'string') throw new Error();
          const bytes = Buffer.from(value, 'base64');
          if (bytes.toString('base64') !== value || (length && bytes.length !== length)) throw new Error();
          return bytes;
        }
        if (parsed.v !== 1) throw new Error();
        const cipher = crypto.createDecipheriv('aes-256-gcm', material, decode(parsed.iv, 12));
        cipher.setAAD(aad);
        cipher.setAuthTag(decode(parsed.tag, 16));
        return Buffer.concat([cipher.update(decode(parsed.data)), cipher.final()]).toString('utf8');
      } catch { throw new Error('Credential decryption refused.'); }
    }
  };
}
module.exports = { createContextCipher };
