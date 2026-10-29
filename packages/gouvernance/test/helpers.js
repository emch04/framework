'use strict';
const crypto = require('node:crypto');
const { createGovernor, createMemoryGovernorStore } = require('@astratra/conscience/governor');
const { createDataGovernance, createMemoryGovernanceStore, createMemoryConnector, signValidation, challengeFor } = require('../src');

const RP_ID = 'validation.example.com';
const ORIGIN = 'https://validation.example.com';

/** Horloge manuelle. */
function makeClock(start = Date.parse('2026-11-03T09:00:00.000Z')) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; return current; };
  now.set = (at) => { current = Date.parse(at); return current; };
  return now;
}

/** Une passkey de test : une paire P-256, comme celles des téléphones. */
function makePasskey(id = `cred-${crypto.randomUUID()}`) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { id, privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

/** Une réponse WebAuthn signée par la passkey pour ce défi (présence et vérification de l'utilisateur par défaut). */
function assert(passkey, challenge, { rpId = RP_ID, origin = ORIGIN, flags = 0x05, type = 'webauthn.get' } = {}) {
  const authenticatorData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin }), 'utf8');
  const signed = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const signature = crypto.sign('sha256', signed, { key: passkey.privateKey, dsaEncoding: 'der' });
  return { authenticatorData: authenticatorData.toString('base64url'), clientDataJSON: clientDataJSON.toString('base64url'), signature: signature.toString('base64url') };
}

/** La clé de signature du service de validation (Ed25519). */
function makeSigningKey(keyId = 'key-2026-11') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { keyId, privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

/** Une validation complète, comme la fabriquerait le service de validation. */
function makeValidation(proposal, { signingKey, decision = 'approve', approvals = [], environment = 'production', issuedAt, expiresInMs = 30 * 60_000, now }) {
  const issued = issuedAt ?? new Date(now()).toISOString();
  return signValidation({
    propositionId: proposal.id, digest: proposal.digest, decision, environment,
    approvals: approvals.map(({ approver, passkey, nonce = crypto.randomUUID(), options }) => ({
      approver, credentialId: passkey.id, nonce, at: issued,
      webauthn: assert(passkey, challengeFor({ propositionId: proposal.id, digest: proposal.digest, decision, environment, approver, nonce }), options)
    })),
    issuedAt: issued, expiresAt: new Date(Date.parse(issued) + expiresInMs).toISOString()
  }, signingKey);
}

const RESOURCES = {
  products: { table: 'products', key: 'id', writable: ['price', 'stock', 'label'], filterable: ['promo', 'category'], tags: ['catalogue'], amount: 'price', maxRows: 50, operations: ['update', 'insert', 'delete'] },
  customers: { table: 'customers', key: 'id', writable: ['email', 'name'], sensitive: ['email'], tags: ['people'], operations: ['update'] }
};

const DATA = {
  products: [
    { id: 'p1', label: 'Tasse', price: 1000, stock: 5, promo: false, category: 'kitchen' },
    { id: 'p2', label: 'Théière', price: 3000, stock: 2, promo: true, category: 'kitchen' },
    { id: 'p3', label: 'Plateau', price: 2000, stock: 9, promo: false, category: 'kitchen' },
    { id: 'p4', label: 'Lampe', price: 4500, stock: 1, promo: false, category: 'light' }
  ],
  customers: [{ id: 'c1', name: 'Client Un', email: 'un@example.com' }]
};

/** Une gouvernance complète en mémoire, avec un approbateur et sa passkey. */
function makeGovernance({ rules, remoteRules, quotas, trust: trustOverride, auditStore, governorStore = createMemoryGovernorStore(), clock = makeClock(), connector, approvers = 1, ...rest } = {}) {
  const governor = createGovernor({ version: 'test', budgets: { perCycle: 1, perAgent: 1, perOrganisation: 1 } }, { store: governorStore, now: clock });
  const signingKey = makeSigningKey();
  const people = Array.from({ length: approvers }, (_v, i) => ({ approver: `approver-${i + 1}`, passkey: makePasskey() }));
  const trust = trustOverride ?? {
    keys: [{ keyId: signingKey.keyId, publicKey: signingKey.publicKey }],
    approvers: people.map((p) => ({ id: p.approver, credentials: [{ id: p.passkey.id, publicKey: p.passkey.publicKey }] })),
    rpId: RP_ID, origins: [ORIGIN]
  };
  const shop = connector ?? createMemoryConnector({ resources: RESOURCES, data: DATA });
  const store = rest.store ?? createMemoryGovernanceStore();
  const events = [];
  const governance = createDataGovernance({
    governor, auditStore: auditStore ?? governorStore, store, connectors: { shop }, rules, remoteRules, quotas, trust, now: clock,
    onEvent: (event) => events.push(event), ...rest
  });
  const validate = (proposal, options = {}) => makeValidation(proposal, { signingKey, approvals: options.approvals ?? people, now: clock, ...options });
  return { governance, governor, governorStore, store, shop, signingKey, people, clock, validate, events };
}

const proposalInput = (overrides = {}) => ({
  organisationId: 'org-a',
  agent: { id: 'assistant', model: 'model-2026-10', instructions: 'consigne-1' },
  requestedBy: { kind: 'human', id: 'user-7' },
  intent: { code: 'raise_prices', confidence: 0.8 },
  actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { promo: false, category: 'kitchen' }, set: { price: { multiply: 1.05, round: 0 } } }],
  explanation: 'Hausse de 5 % hors promotions.',
  ...overrides
});

module.exports = { RP_ID, ORIGIN, RESOURCES, DATA, makeClock, makePasskey, assert, makeSigningKey, makeValidation, makeGovernance, proposalInput };
