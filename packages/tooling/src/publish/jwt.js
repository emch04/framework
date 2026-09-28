const crypto = require('crypto');
const { ToolingError } = require('../errors');

function base64url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return buffer.toString('base64url');
}

function toKeyObject(key) {
  if (key && typeof key === 'object' && typeof key.type === 'string' && key.asymmetricKeyType) {
    return key;
  }

  try {
    return crypto.createPrivateKey(key);
  } catch (_error) {
    // The key's text is never repeated: only that it could not be read.
    throw new ToolingError('JWT_KEY_INVALID', 'La cle privee est illisible (format PEM attendu).', 400);
  }
}

/**
 * Signs a compact JWT with node:crypto only.
 * - RS256: RSA + SHA-256, PKCS#1 v1.5 (Google service accounts).
 * - ES256: P-256 + SHA-256, signature in the raw r||s form JOSE requires
 *   (`dsaEncoding: 'ieee-p1363'`) — the default DER form is rejected by Apple.
 */
function signJwt({ header = {}, payload, privateKey, algorithm }) {
  if (algorithm !== 'RS256' && algorithm !== 'ES256') {
    throw new ToolingError('JWT_ALGORITHM_UNSUPPORTED', `Algorithme JWT non pris en charge : ${algorithm}`, 400);
  }

  const key = toKeyObject(privateKey);
  const expectedType = algorithm === 'RS256' ? 'rsa' : 'ec';
  if (key.asymmetricKeyType !== expectedType) {
    throw new ToolingError('JWT_KEY_INVALID', `La cle privee ne convient pas a ${algorithm} (cle ${key.asymmetricKeyType} fournie).`, 400);
  }

  const signingInput = `${base64url({ ...header, alg: algorithm, typ: 'JWT' })}.${base64url(payload)}`;
  const signature = algorithm === 'RS256'
    ? crypto.sign('sha256', Buffer.from(signingInput), key)
    : crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });

  return `${signingInput}.${base64url(signature)}`;
}

/** Splits a compact JWT for inspection (tests, diagnostics). Never verifies. */
function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw new ToolingError('JWT_MALFORMED', 'Jeton JWT mal forme.', 400);
  }

  return {
    header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    signature: Buffer.from(parts[2], 'base64url'),
    signingInput: `${parts[0]}.${parts[1]}`
  };
}

module.exports = {
  base64url,
  decodeJwt,
  signJwt
};
