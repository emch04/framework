'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyValidation, createTrust, signValidation, challengeFor, digestOf } = require('../src');
const { makePasskey, assert: sign, makeSigningKey, makeValidation, makeClock, RP_ID, ORIGIN } = require('./helpers');

const clock = makeClock();
const body = { schema: 'gouvernance-proposition/1', id: 'prop-1', organisationId: 'org-a', environment: 'production', requestedBy: { kind: 'human', id: 'user-7' }, actions: [] };
const proposal = { ...body, digest: digestOf(body) };
const key = makeSigningKey();
const passkey = makePasskey();
const trustInput = {
  keys: [{ keyId: key.keyId, publicKey: key.publicKey }],
  approvers: [{ id: 'approver-1', credentials: [{ id: passkey.id, publicKey: passkey.publicKey }] }],
  rpId: RP_ID, origins: [ORIGIN]
};
const trust = createTrust(trustInput);
const check = (validation, extra = {}) => verifyValidation(validation, { trust, proposal, environment: 'production', now: clock(), ...extra });
const valid = (options = {}) => makeValidation(proposal, { signingKey: key, approvals: [{ approver: 'approver-1', passkey }], now: clock, ...options });

test('une validation correcte passe, avec ses approbateurs', () => {
  assert.deepEqual(check(valid()), { ok: true, decision: 'approve', approvers: ['approver-1'] });
});

test('le défi dépend de chaque champ', () => {
  const base = { propositionId: 'p', digest: 'd', decision: 'approve', environment: 'production', approver: 'a', nonce: 'n' };
  const reference = challengeFor(base);
  for (const field of Object.keys(base)) {
    const changed = { ...base, [field]: field === 'decision' ? 'decline' : `${base[field]}x` };
    assert.notEqual(challengeFor(changed), reference, field);
  }
});

test('signature : clé inconnue, signature fausse, champ modifié après signature', () => {
  assert.equal(check({ ...valid(), keyId: 'autre' }).code, 'unknown_key');
  assert.equal(check({ ...valid(), signature: valid().signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }).code, 'bad_signature');
  assert.equal(check({ ...valid(), expiresAt: '2099-01-01T00:00:00.000Z' }).code, 'bad_signature');
  const other = makeSigningKey(key.keyId);
  assert.equal(check(makeValidation(proposal, { signingKey: other, approvals: [{ approver: 'approver-1', passkey }], now: clock })).code, 'bad_signature');
  assert.equal(check(null).code, 'bad_signature');
});

test('une signature RSA ou HMAC n\'est pas acceptée comme clé du service', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => createTrust({ ...trustInput, keys: [{ keyId: 'k', publicKey }] }), { code: 'invalid_trust' });
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => signValidation({}, { privateKey, keyId: 'k' }), { code: 'invalid_key' });
});

test('proposition modifiée d\'un octet : refusée', () => {
  const changed = { ...proposal, organisationId: 'org-b' };
  assert.equal(verifyValidation(valid(), { trust, proposal: changed, environment: 'production', now: clock() }).code, 'proposal_modified');
  const forged = { ...changed, digest: digestOf({ ...body, organisationId: 'org-b' }) };
  assert.equal(verifyValidation(valid(), { trust, proposal: forged, environment: 'production', now: clock() }).code, 'proposal_modified');
});

test('dates : expirée, trop ancienne, venue du futur', () => {
  assert.equal(check(valid(), { now: clock() + 31 * 60_000 }).code, 'expired');
  assert.equal(check(valid({ expiresInMs: 3 * 3600_000 }), { now: clock() + 2 * 3600_000 }).code, 'expired', 'maxAgeMs plafonne une validation longue');
  assert.equal(check(valid({ issuedAt: new Date(clock() + 5 * 60_000).toISOString() })).code, 'expired');
});

test('environnement : une validation de préproduction ne vaut pas en production', () => {
  assert.equal(check(valid({ environment: 'staging' })).code, 'wrong_environment');
});

test('preuve humaine : autre défi, autre origine, autre rpId, sans vérification de l\'utilisateur', () => {
  const tampered = valid();
  tampered.approvals[0].webauthn = sign(passkey, challengeFor({ propositionId: 'autre', digest: proposal.digest, decision: 'approve', environment: 'production', approver: 'approver-1', nonce: tampered.approvals[0].nonce }));
  assert.equal(check(signValidation(tampered, key)).code, 'bad_human_proof');
  for (const options of [{ origin: 'https://evil.example.com' }, { rpId: 'evil.example.com' }, { flags: 0x01 }, { type: 'webauthn.create' }]) {
    assert.equal(check(valid({ approvals: [{ approver: 'approver-1', passkey, options }] })).code, 'bad_human_proof', JSON.stringify(options));
  }
});

test('approbateurs : inconnu, passkey d\'un autre, doublon, auto-approbation', () => {
  assert.equal(check(valid({ approvals: [{ approver: 'intrus', passkey }] })).code, 'not_an_approver');
  assert.equal(check(valid({ approvals: [{ approver: 'approver-1', passkey: makePasskey() }] })).code, 'not_an_approver');
  assert.equal(check(valid({ approvals: [{ approver: 'approver-1', passkey }, { approver: 'approver-1', passkey }] })).code, 'duplicate_approver');
  const selfTrust = createTrust({ ...trustInput, approvers: [{ id: 'approver-1', subject: 'user-7', credentials: [{ id: passkey.id, publicKey: passkey.publicKey }] }] });
  assert.equal(verifyValidation(valid(), { trust: selfTrust, proposal, environment: 'production', now: clock() }).code, 'self_approval');
  assert.equal(check(valid({ approvals: [] })).code, 'not_enough_approvals');
});

test('mode hybride : une passkey de l\'application elle-même, avec son propre domaine', () => {
  const appKey = makePasskey();
  const hybrid = createTrust({ ...trustInput, approvers: [{ id: 'director', credentials: [{ id: appKey.id, publicKey: appKey.publicKey, rpId: 'app.example.com', origins: ['https://app.example.com'] }] }] });
  const validation = makeValidation(proposal, { signingKey: key, approvals: [{ approver: 'director', passkey: appKey, options: { rpId: 'app.example.com', origin: 'https://app.example.com' } }], now: clock });
  assert.equal(verifyValidation(validation, { trust: hybrid, proposal, environment: 'production', now: clock() }).ok, true);
});

test('rotation : une clé retirée ne vaut plus pour une validation émise après son retrait', () => {
  const retired = createTrust({ ...trustInput, keys: [{ keyId: key.keyId, publicKey: key.publicKey, notAfter: new Date(clock() - 1000).toISOString() }] });
  assert.equal(verifyValidation(valid(), { trust: retired, proposal, environment: 'production', now: clock() }).code, 'unknown_key');
});

test('clés publiques acceptées en PEM, en SPKI base64 et en KeyObject', () => {
  const object = crypto.createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  for (const publicKey of [key.publicKey, object, object.export({ type: 'spki', format: 'pem' })]) {
    const t = createTrust({ ...trustInput, keys: [{ keyId: key.keyId, publicKey }] });
    assert.equal(verifyValidation(valid(), { trust: t, proposal, environment: 'production', now: clock() }).ok, true);
  }
});
