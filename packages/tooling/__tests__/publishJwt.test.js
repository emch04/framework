const crypto = require('crypto');
const { base64url, decodeJwt, signJwt } = require('../src/publish/jwt');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
const ecPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });

describe('JWT signing', () => {
  test('RS256 token verifies with the matching public key', () => {
    const token = signJwt({ algorithm: 'RS256', payload: { iss: 'a@b.iam', iat: 1 }, privateKey: rsaPem });
    const decoded = decodeJwt(token);

    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decoded.payload).toEqual({ iss: 'a@b.iam', iat: 1 });
    expect(crypto.verify('sha256', Buffer.from(decoded.signingInput), rsa.publicKey, decoded.signature)).toBe(true);
  });

  test('ES256 signature is the 64-byte r||s form JOSE requires, not DER', () => {
    const token = signJwt({ algorithm: 'ES256', header: { kid: 'ABC123DEFG' }, payload: { aud: 'x' }, privateKey: ecPem });
    const decoded = decodeJwt(token);

    expect(decoded.header).toEqual({ kid: 'ABC123DEFG', alg: 'ES256', typ: 'JWT' });
    expect(decoded.signature).toHaveLength(64);
    expect(crypto.verify('sha256', Buffer.from(decoded.signingInput), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, decoded.signature)).toBe(true);
  });

  test('a tampered payload no longer verifies', () => {
    const token = signJwt({ algorithm: 'RS256', payload: { scope: 'read' }, privateKey: rsaPem });
    const [header, , signature] = token.split('.');
    const forged = `${header}.${base64url({ scope: 'admin' })}`;

    expect(crypto.verify('sha256', Buffer.from(forged), rsa.publicKey, Buffer.from(signature, 'base64url'))).toBe(false);
  });

  test('refuses a key of the wrong family', () => {
    expect(() => signJwt({ algorithm: 'ES256', payload: {}, privateKey: rsaPem })).toThrow(expect.objectContaining({ code: 'JWT_KEY_INVALID' }));
    expect(() => signJwt({ algorithm: 'RS256', payload: {}, privateKey: ecPem })).toThrow(expect.objectContaining({ code: 'JWT_KEY_INVALID' }));
  });

  test('an unreadable key is reported without repeating its text', () => {
    const pem = (label) => ['-----', label, '-----'].join('');
    const garbage = [pem('BEGIN ' + 'PRIVATE KEY'), 'SECRETSECRETSECRET', pem('END ' + 'PRIVATE KEY')].join('\n');
    let caught;
    try {
      signJwt({ algorithm: 'RS256', payload: {}, privateKey: garbage });
    } catch (error) {
      caught = error;
    }
    expect(caught.code).toBe('JWT_KEY_INVALID');
    expect(caught.message).not.toContain('SECRETSECRET');
  });

  test('rejects algorithms other than RS256 and ES256', () => {
    expect(() => signJwt({ algorithm: 'none', payload: {}, privateKey: rsaPem })).toThrow(expect.objectContaining({ code: 'JWT_ALGORITHM_UNSUPPORTED' }));
    expect(() => decodeJwt('a.b')).toThrow(expect.objectContaining({ code: 'JWT_MALFORMED' }));
  });
});
