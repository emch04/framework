const fs = require('node:fs');
const path = require('node:path');
const {
  APPLE_WWDR_G4, readPassCertificate, checkAppleCredentials, readGoogleServiceAccount,
  checkGoogleCredentials, toHexField, fromHexField
} = require('../src');

const lire = (nom) => fs.readFileSync(path.join(__dirname, 'fixtures', nom), 'utf8');
const CERT = lire('pass-test.pem');
const CLE = lire('pass-test.key');

test('le certificat WWDR G4 d’Apple est fourni', () => {
  expect(APPLE_WWDR_G4).toMatch(/BEGIN CERTIFICATE/);
});

test('le certificat donne son identifiant de carte, son équipe et son expiration', () => {
  const lu = readPassCertificate(CERT);
  expect(lu).toMatchObject({ passTypeIdentifier: 'pass.com.test.fidelite', teamIdentifier: 'TEAM123456' });
  expect(new Date(lu.expiresAt).getTime()).toBeGreaterThan(Date.now());
  expect(readPassCertificate('pas un certificat')).toBeNull();
});

test('un certificat et sa clé passent, une autre clé ou un certificat expiré non', () => {
  expect(checkAppleCredentials({ certificate: CERT, privateKey: CLE })).toEqual({ ok: true });
  expect(checkAppleCredentials({ certificate: CERT, privateKey: lire('autre-cle.key') }).reason).toMatch(/ne correspond pas/);
  expect(checkAppleCredentials({ certificate: CERT, privateKey: CLE }, Date.parse('2100-01-01')).reason).toMatch(/expiré/);
  expect(checkAppleCredentials({ certificate: CERT }).ok).toBe(false);
});

test('compte de service Google et ID émetteur', () => {
  const compte = JSON.stringify({ type: 'service_account', client_email: 'a@b.iam.gserviceaccount.com', private_key: CLE });
  expect(readGoogleServiceAccount(compte).client_email).toBe('a@b.iam.gserviceaccount.com');
  expect(readGoogleServiceAccount('{"type":"user"}')).toBeNull();
  expect(checkGoogleCredentials({ issuerId: '3388000000000000000', serviceAccount: compte })).toEqual({ ok: true });
  expect(checkGoogleCredentials({ issuerId: 'abc' }).ok).toBe(false);
  expect(checkGoogleCredentials({}).ok).toBe(false);
});

test('un PEM traverse en hexadécimal et revient intact ; le reste est refusé', () => {
  const hex = toHexField(CERT);
  expect(hex).toMatch(/^[0-9a-f]+$/);
  expect(fromHexField(hex)).toBe(CERT);
  expect(fromHexField('-----BEGIN')).toBe('');
  expect(fromHexField(undefined)).toBeUndefined();
});
