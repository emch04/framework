'use strict';
const crypto = require('node:crypto');
const { GouvernanceError } = require('./errors');
const { stableStringify, digestOf } = require('./stable');
const { VALIDATION_SCHEMA, CHALLENGE_SCHEMA, NAME, isPlainObject } = require('./contract');

/*
 * La validation signée. Deux preuves, vérifiées par l'application qui exécute :
 * 1. la passkey de la personne (Face ID, Touch ID, code de l'appareil) : le défi WebAuthn est
 *    l'empreinte de CETTE proposition et de CETTE décision ; l'application la revérifie avec SA
 *    liste de clés publiques d'approbateurs ;
 * 2. la signature Ed25519 du service de validation sur toute la validation : elle dit que la
 *    règle en vigueur a été appliquée (bons approbateurs, bon nombre, pas interdit).
 * L'application ne garde que des clés publiques : rien de secret à voler chez elle. Un service
 * de validation compromis ne peut pas fabriquer une validation : il lui manque la passkey.
 */

const DECISIONS = Object.freeze(['approve', 'decline', 'undo']);
const PRESENCE = 0x01;
const VERIFICATION = 0x04;

const fail = (code, message) => { throw new GouvernanceError(code, message); };

/** Une clé publique : KeyObject, PEM, ou SPKI DER en base64 / base64url. */
function publicKeyFrom(value) {
  if (value instanceof crypto.KeyObject) {
    if (value.type !== 'public') fail('invalid_trust', 'Une clé publique est attendue.');
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) fail('invalid_trust', 'Clé publique absente.');
  try {
    if (value.includes('-----BEGIN')) return crypto.createPublicKey(value);
    return crypto.createPublicKey({ key: Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64'), format: 'der', type: 'spki' });
  } catch (_error) {
    return fail('invalid_trust', 'Clé publique illisible.');
  }
}

/** Une clé privée : KeyObject, PEM, ou PKCS8 DER en base64. */
function privateKeyFrom(value) {
  if (value instanceof crypto.KeyObject) return value;
  try {
    if (typeof value === 'string' && value.includes('-----BEGIN')) return crypto.createPrivateKey(value);
    return crypto.createPrivateKey({ key: Buffer.from(String(value), 'base64'), format: 'der', type: 'pkcs8' });
  } catch (_error) {
    return fail('invalid_key', 'Clé privée illisible.');
  }
}

/**
 * Le défi WebAuthn d'une décision : SHA-256 (base64url) de
 * { schema, propositionId, digest, decision, environment, approver, nonce }.
 * Le même calcul chez le service de validation et dans l'application.
 */
function challengeFor({ propositionId, digest, decision, environment, approver, nonce }) {
  for (const [label, value] of Object.entries({ propositionId, digest, decision, environment, approver, nonce })) {
    if (typeof value !== 'string' || !value) fail('invalid_challenge', `Défi : ${label} manquant.`);
  }
  if (!DECISIONS.includes(decision)) fail('invalid_challenge', `Décision inconnue : ${decision}.`);
  return digestOf({ schema: CHALLENGE_SCHEMA, propositionId, digest, decision, environment, approver, nonce });
}

const bodyOf = (validation) => {
  const body = { ...validation };
  delete body.signature;
  return body;
};

/** Signe une validation (Ed25519) : pour le service de validation, et pour les tests. */
function signValidation(validation, { privateKey, keyId }) {
  if (!isPlainObject(validation)) fail('invalid_validation', 'La validation doit être un objet.');
  if (typeof keyId !== 'string' || !NAME.test(keyId)) fail('invalid_key', 'keyId invalide.');
  const key = privateKeyFrom(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') fail('invalid_key', 'La clé de signature doit être Ed25519.');
  const body = { ...bodyOf(validation), schema: VALIDATION_SCHEMA, keyId };
  const signature = crypto.sign(null, Buffer.from(stableStringify(body), 'utf8'), key).toString('base64url');
  return { ...body, signature };
}

function memeTexte(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Revérifie une réponse WebAuthn contre le défi attendu, une clé publique, le rpId et les origines permises. */
function verifyAssertion({ webauthn, challenge, publicKey, rpId, origins }) {
  let clientData;
  let authenticator;
  let signature;
  let client;
  try {
    clientData = Buffer.from(String(webauthn.clientDataJSON), 'base64url');
    authenticator = Buffer.from(String(webauthn.authenticatorData), 'base64url');
    signature = Buffer.from(String(webauthn.signature), 'base64url');
    client = JSON.parse(clientData.toString('utf8'));
  } catch (_error) {
    return 'unreadable';
  }
  if (!client || authenticator.length < 37 || !signature.length) return 'unreadable';
  if (client.type !== 'webauthn.get') return 'type';
  if (typeof client.challenge !== 'string' || !memeTexte(client.challenge, challenge)) return 'challenge';
  if (typeof client.origin !== 'string' || !origins.includes(client.origin)) return 'origin';
  const expectedRp = crypto.createHash('sha256').update(rpId, 'utf8').digest();
  if (!crypto.timingSafeEqual(authenticator.subarray(0, 32), expectedRp)) return 'rp';
  const flags = authenticator[32];
  if (!(flags & PRESENCE) || !(flags & VERIFICATION)) return 'user_verification';
  const signed = Buffer.concat([authenticator, crypto.createHash('sha256').update(clientData).digest()]);
  let valid = false;
  try {
    const type = publicKey.asymmetricKeyType;
    if (type === 'ec') valid = crypto.verify('sha256', signed, { key: publicKey, dsaEncoding: 'der' }, signature);
    else if (type === 'rsa') valid = crypto.verify('sha256', signed, publicKey, signature);
    else if (type === 'ed25519') valid = crypto.verify(null, signed, publicKey, signature);
  } catch (_error) {
    valid = false;
  }
  return valid ? null : 'signature';
}

/**
 * La confiance de l'application : clés publiques du service de validation, approbateurs
 * (chacun avec ses passkeys), partie de confiance WebAuthn par défaut.
 * { keys: [{ keyId, publicKey, notAfter? }], approvers: [{ id, subject?, credentials: [{ id, publicKey, rpId?, origins? }] }],
 *   rpId, origins, maxAgeMs = 30 min, skewMs = 30 s }
 */
function createTrust(trust) {
  if (!isPlainObject(trust)) fail('invalid_trust', 'La confiance (trust) est obligatoire.');
  if (!Array.isArray(trust.keys) || !trust.keys.length) fail('invalid_trust', 'Au moins une clé publique du service de validation.');
  const keys = new Map();
  for (const entry of trust.keys) {
    if (!isPlainObject(entry) || typeof entry.keyId !== 'string' || !NAME.test(entry.keyId)) fail('invalid_trust', 'Chaque clé a un keyId.');
    const key = publicKeyFrom(entry.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') fail('invalid_trust', `La clé ${entry.keyId} doit être Ed25519.`);
    const notAfter = entry.notAfter === undefined ? null : Date.parse(entry.notAfter);
    if (notAfter !== null && Number.isNaN(notAfter)) fail('invalid_trust', `notAfter invalide pour ${entry.keyId}.`);
    keys.set(entry.keyId, { key, notAfter });
  }
  const rpId = trust.rpId ?? null;
  const origins = trust.origins ?? [];
  if (!Array.isArray(origins) || !origins.every((o) => typeof o === 'string')) fail('invalid_trust', 'origins doit être une liste.');
  const approvers = new Map();
  for (const approver of trust.approvers ?? []) {
    if (!isPlainObject(approver) || typeof approver.id !== 'string' || !approver.id) fail('invalid_trust', 'Chaque approbateur a un id.');
    const credentials = new Map();
    for (const credential of approver.credentials ?? []) {
      if (!isPlainObject(credential) || typeof credential.id !== 'string' || !credential.id) fail('invalid_trust', `Passkey sans id pour ${approver.id}.`);
      const credentialRp = credential.rpId ?? rpId;
      const credentialOrigins = credential.origins ?? origins;
      if (typeof credentialRp !== 'string' || !credentialRp || !credentialOrigins.length) fail('invalid_trust', `rpId et origins manquent pour une passkey de ${approver.id}.`);
      credentials.set(credential.id, { publicKey: publicKeyFrom(credential.publicKey), rpId: credentialRp, origins: [...credentialOrigins] });
    }
    if (!credentials.size) fail('invalid_trust', `L'approbateur ${approver.id} n'a aucune passkey.`);
    approvers.set(approver.id, { id: approver.id, subject: approver.subject ?? null, credentials });
  }
  const maxAgeMs = trust.maxAgeMs ?? 30 * 60_000;
  const skewMs = trust.skewMs ?? 30_000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || !Number.isSafeInteger(skewMs) || skewMs < 0) fail('invalid_trust', 'maxAgeMs et skewMs en millisecondes.');
  return Object.freeze({ keys, approvers, maxAgeMs, skewMs });
}

/**
 * Vérifie une validation signée pour une proposition gardée par l'application.
 * Rend { ok: true, decision, approvers } ou { ok: false, code }. L'ordre des contrôles est
 * fixe : signature d'abord (on n'interprète rien de ce qu'un inconnu a envoyé), puis
 * l'empreinte recalculée sur NOTRE copie, les dates, puis chaque preuve humaine.
 */
function verifyValidation(validation, { trust, proposal, environment, now = Date.now() }) {
  if (!isPlainObject(validation) || validation.schema !== VALIDATION_SCHEMA || typeof validation.signature !== 'string') return { ok: false, code: 'bad_signature' };
  const entry = trust.keys.get(validation.keyId);
  if (!entry) return { ok: false, code: 'unknown_key' };
  let signedOk = false;
  try {
    signedOk = crypto.verify(null, Buffer.from(stableStringify(bodyOf(validation)), 'utf8'), entry.key, Buffer.from(validation.signature, 'base64url'));
  } catch (_error) {
    signedOk = false;
  }
  if (!signedOk) return { ok: false, code: 'bad_signature' };
  if (validation.propositionId !== proposal.id) return { ok: false, code: 'wrong_proposal' };
  if (!memeTexte(validation.digest, digestOf(withoutDigest(proposal))) || !memeTexte(validation.digest, proposal.digest)) return { ok: false, code: 'proposal_modified' };
  if (validation.environment !== environment || proposal.environment !== environment) return { ok: false, code: 'wrong_environment' };
  if (!DECISIONS.includes(validation.decision)) return { ok: false, code: 'wrong_decision' };
  const issued = Date.parse(validation.issuedAt);
  const expires = Date.parse(validation.expiresAt);
  if (Number.isNaN(issued) || Number.isNaN(expires) || expires <= issued) return { ok: false, code: 'expired' };
  if (issued > now + trust.skewMs || now > expires || now - issued > trust.maxAgeMs) return { ok: false, code: 'expired' };
  if (entry.notAfter !== null && issued > entry.notAfter) return { ok: false, code: 'unknown_key' };
  if (validation.decision === 'decline') return { ok: true, decision: 'decline', approvers: [] };

  if (!Array.isArray(validation.approvals) || !validation.approvals.length) return { ok: false, code: 'not_enough_approvals' };
  const approvers = [];
  for (const approval of validation.approvals) {
    if (!isPlainObject(approval) || !isPlainObject(approval.webauthn)) return { ok: false, code: 'bad_human_proof' };
    const approver = trust.approvers.get(approval.approver);
    if (!approver) return { ok: false, code: 'not_an_approver' };
    if (approver.subject !== null && approver.subject === proposal.requestedBy?.id) return { ok: false, code: 'self_approval' };
    const credential = approver.credentials.get(approval.credentialId);
    if (!credential) return { ok: false, code: 'not_an_approver' };
    if (typeof approval.nonce !== 'string' || !approval.nonce) return { ok: false, code: 'bad_human_proof' };
    const challenge = challengeFor({ propositionId: proposal.id, digest: proposal.digest, decision: validation.decision, environment, approver: approver.id, nonce: approval.nonce });
    if (verifyAssertion({ webauthn: approval.webauthn, challenge, ...credential })) return { ok: false, code: 'bad_human_proof' };
    if (approvers.includes(approver.id)) return { ok: false, code: 'duplicate_approver' };
    approvers.push(approver.id);
  }
  return { ok: true, decision: validation.decision, approvers };
}

function withoutDigest(proposal) {
  const rest = { ...proposal };
  delete rest.digest;
  return rest;
}

module.exports = { DECISIONS, challengeFor, signValidation, verifyValidation, verifyAssertion, createTrust, publicKeyFrom, withoutDigest };
