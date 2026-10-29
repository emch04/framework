'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trustSuggestions, outcomeOfRecord } = require('../src');
const { makeGovernance, proposalInput } = require('./helpers');

const entries = (n, outcome, extra = {}) => Array.from({ length: n }, (_, i) => ({
  id: `${outcome}-${extra.prefix ?? ''}${i}`, agent: 'assistant', resource: 'products', ops: ['update'], level: 'validation',
  confidence: 0.9, outcome, at: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T09:00:00Z`, ...extra
}));

test('assez de preuves et aucune annulation : suggestion d\'assouplir, jamais plus loin que « libre avec avis »', () => {
  const [r] = trustSuggestions([...entries(118, 'approved'), ...entries(2, 'declined')]);
  assert.equal(r.sampleSize, 120);
  assert.ok(r.rate > 0.98);
  assert.equal(r.status, 'observed');
  assert.deepEqual(r.suggestion && [r.suggestion.action, r.suggestion.from, r.suggestion.to], ['loosen', 'validation', 'free_with_notice']);
  assert.deepEqual(r.suggestion.rule, { id: 'confiance-assistant-products', level: 'free_with_notice', match: { agents: ['assistant'], resources: ['products'], ops: ['update'] } });
});

test('trop peu de cas : aucune conclusion, même à 100 %', () => {
  const [r] = trustSuggestions(entries(12, 'approved'));
  assert.equal(r.rate, 1);
  assert.equal(r.status, 'insufficient_data');
  assert.equal(r.suggestion, null);
});

test('une seule annulation suffit à bloquer l\'assouplissement', () => {
  const [r] = trustSuggestions([...entries(200, 'approved'), ...entries(1, 'undone')]);
  assert.equal(r.suggestion, null);
});

test('un taux de réussite insuffisant (borne basse sous 90 %) : pas de suggestion', () => {
  const [r] = trustSuggestions([...entries(40, 'approved'), ...entries(8, 'declined')]);
  assert.equal(r.status, 'observed');
  assert.equal(r.suggestion, null);
});

test('actions libres annulées : suggestion de resserrer vers la validation', () => {
  const [r] = trustSuggestions([...entries(20, 'unreviewed', { level: 'free_with_notice' }), ...entries(4, 'undone', { level: 'free_with_notice' })]);
  assert.deepEqual([r.suggestion.action, r.suggestion.from, r.suggestion.to], ['tighten', 'free_with_notice', 'validation']);
});

test('« interdit » n\'est jamais suggéré ni assoupli ; les inconnus restent hors des comptes', () => {
  const [r] = trustSuggestions([...entries(100, 'approved', { level: 'forbidden' }), ...entries(50, 'unknown', { level: 'forbidden' })]);
  assert.equal(r.suggestion, null);
  assert.equal(r.sampleSize, 100);
  assert.equal(r.counts.unknown, 50);
});

test('regroupé par IA, ressource et opérations ; une proposition ne compte qu\'une fois', () => {
  const autres = entries(5, 'approved', { agent: 'autre' });
  const doublons = [...entries(3, 'approved'), ...entries(3, 'approved')];
  const rapport = trustSuggestions([...autres, ...doublons]);
  assert.equal(rapport.length, 2);
  assert.equal(rapport.find((r) => r.agent === 'assistant').sampleSize, 3);
});

test('calibration : une IA qui se dit sûre à 90 % mais a raison une fois sur deux est surconfiante', () => {
  const [r] = trustSuggestions([...entries(30, 'approved'), ...entries(30, 'declined')]);
  assert.ok(r.calibration.overconfidence > 0.35);
  assert.equal(r.calibration.status, 'observed');
});

test('entrées mal formées : refusées', () => {
  for (const bad of [[{ id: 'x' }], [{ ...entries(1, 'approved')[0], outcome: 'peut-être' }], [{ ...entries(1, 'approved')[0], confidence: 2 }], 'tout']) {
    assert.throws(() => trustSuggestions(bad), { code: 'invalid_trust_input' });
  }
});

test('issue d\'une proposition du pack, et rapport tiré de son magasin', async () => {
  assert.equal(outcomeOfRecord({ status: 'executed', validation: { decision: 'approve' } }), 'approved');
  assert.equal(outcomeOfRecord({ status: 'stale', validation: { decision: 'approve' } }), 'approved', 'la personne avait dit oui : l\'IA avait raison');
  assert.equal(outcomeOfRecord({ status: 'executed', validation: null }), 'unreviewed');
  assert.equal(outcomeOfRecord({ status: 'undone', validation: { decision: 'approve' } }), 'undone');
  assert.equal(outcomeOfRecord({ status: 'declined' }), 'declined');
  assert.equal(outcomeOfRecord({ status: 'awaiting_validation' }), 'unknown');
  const { governance, validate } = makeGovernance();
  const a = await governance.propose(proposalInput());
  await governance.applyValidation(validate(a.proposal), { organisationId: 'org-a' });
  const b = await governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { id: 'p4' }, set: { stock: 0 } }] }));
  await governance.applyValidation(validate(b.proposal, { decision: 'decline', approvals: [] }), { organisationId: 'org-a' });
  const [r] = await governance.trustReport({ organisationId: 'org-a' });
  assert.deepEqual([r.counts.approved, r.counts.declined, r.status, r.suggestion], [1, 1, 'insufficient_data', null]);
});
