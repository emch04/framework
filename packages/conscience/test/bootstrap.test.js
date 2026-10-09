'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGovernor, assertGovernorReady, validatePolicy, DEFAULT_CONSTITUTION, PROTECTED_SCOPES } = require('../src/governor');
const { createConscience } = require('../src');
const { policy, mask } = require('./helpers');

test('no governor, a fake governor, or no masker: conscience refuses to start', () => {
  assert.throws(() => createConscience({ masker: mask }), { code: 'governor_missing' });
  assert.throws(() => createConscience({ masker: mask, governor: { assertReady: async () => true, assertSingleOrganisation: () => 'x' } }), { code: 'governor_invalid' });
  assert.throws(() => createConscience({ governor: createGovernor(policy()) }), { code: 'masker_required' });
  assert.throws(() => createConscience({ governor: createGovernor(policy()), masker: mask, retention: { erasure: 'forget' } }), { code: 'invalid_input' });
  assert.ok(createConscience({ governor: createGovernor(policy()), masker: { redactString: (t) => t } }));
});

test('missing or invalid policy: the governor does not exist', async () => {
  assert.throws(() => createGovernor(), { code: 'policy_missing' });
  assert.throws(() => createGovernor({}), { code: 'policy_invalid' });
  assert.throws(() => createGovernor({ budgets: { perCycle: 1, perAgent: 1, perOrganisation: -1 } }), { code: 'policy_invalid' });
  assert.throws(() => createGovernor(policy({ automaticChanges: 'all' })), { code: 'policy_invalid' });
  assert.throws(() => createGovernor(policy({ permissions: { modifiable: ['instructions', 'permissions'] } })), { code: 'policy_invalid' });
  assert.throws(() => createGovernor(policy({ constitution: [{ id: 'protect-budgets', description: 'dup', protectedScope: 'x', owner: 'me' }] })), { code: 'policy_invalid' });
  assert.throws(() => createGovernor(policy({ isolation: 'none' })), { code: 'policy_invalid' });
  await assert.rejects(assertGovernorReady(undefined), { code: 'governor_missing' });
  await assert.rejects(assertGovernorReady({ assertReady: async () => true }), { code: 'governor_invalid' });
  const halted = createGovernor(policy({ halted: true }));
  await assert.rejects(assertGovernorReady(halted), { code: 'governor_halted' });
});

test('an unreachable governor store makes the governor unavailable', async () => {
  const broken = { putProposal() {}, getProposal() {}, transitionProposal() {}, listProposals() {}, appendAudit() {}, listAudit() {}, reserveSpend() {}, setControl() {}, getObject() {}, createObject() {}, updateObject() {}, listObjects() {}, putVersion() {}, getVersion() {}, listVersions() {}, putFinding() {}, listFindings() {}, async getControl() { throw new Error('connection refused'); } };
  await assert.rejects(assertGovernorReady(createGovernor(policy(), { store: broken })), { code: 'governor_unavailable' });
  assert.throws(() => createGovernor(policy(), { store: {} }), { code: 'governor_unavailable' });
});

test('the default constitution is always there and the policy is frozen', () => {
  const rules = validatePolicy(policy({ constitution: [{ id: 'protect-payments-routing', description: 'Payments routing is fixed.', protectedScope: 'routing:payments', owner: 'finance' }] }));
  assert.deepEqual(rules.constitution.slice(0, PROTECTED_SCOPES.length).map((r) => r.id), DEFAULT_CONSTITUTION.map((r) => r.id));
  assert.ok(Object.isFrozen(rules) && Object.isFrozen(rules.budgets) && Object.isFrozen(rules.constitution[0]));
  assert.throws(() => { 'use strict'; rules.budgets.perCycle = 1e9; }, TypeError);
  const governor = createGovernor(policy({ constitution: [{ id: 'protect-payments-routing', description: 'Payments routing is fixed.', protectedScope: 'routing:payments', owner: 'finance' }] }));
  const copy = governor.getPolicy();
  copy.budgets.perCycle = 1e9;
  assert.equal(governor.getPolicy().budgets.perCycle, 5);
  return governor.evaluatePolicy({ id: 'p', organisationId: 'o', target: { kind: 'routing', id: 'payments' }, change: { model: 'cheap' }, proposedBy: { kind: 'engine', id: 'e' } })
    .then((result) => { assert.equal(result.status, 'rejected'); assert.deepEqual(result.rules, ['protect-payments-routing']); });
});
