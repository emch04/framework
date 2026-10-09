'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGovernor, createMemoryGovernorStore, validatePolicy, DECLINE_REASONS, RISK_LEVELS, rolloutBucket } = require('../src/governor');
const { advancedContract } = require('./advancedContract');
const { policy, makeClock } = require('./helpers');

advancedContract('memory', async () => ({ store: createMemoryGovernorStore() }));

test('the approval policy is validated and frozen; the register of reasons only grows', () => {
  const rules = validatePolicy(policy());
  assert.deepEqual([rules.approvals.doubleApprovalFrom, rules.approvals.expiresInMs, rules.approvals.distinctRoles], ['high', 7 * 86400000, false]);
  assert.deepEqual(rules.approvals.declineReasons.slice(0, DECLINE_REASONS.length), [...DECLINE_REASONS]);
  assert.ok(Object.isFrozen(rules.approvals) && Object.isFrozen(rules.approvals.floors));
  assert.deepEqual(validatePolicy(policy({ approvals: { declineReasons: ['too_costly'] } })).approvals.declineReasons.at(-1), 'too_costly');
  const bad = (approvals) => assert.throws(() => validatePolicy(policy({ approvals })), { code: 'policy_invalid' });
  bad({ expiresInMs: 0 }); bad({ expiresInMs: 1.5 }); bad({ doubleApprovalFrom: 'extreme' }); bad({ floors: { routing: 'extreme' } });
  bad({ floors: { weights: 'high' } }); bad({ matrix: { weights: { roles: ['owner'] } } }); bad({ matrix: { routing: { roles: ['owner'] } } });
  bad({ matrix: { routing: { approvals: 9 } } }); bad({ roles: { 'admin-1': [] } }); bad({ declineReasons: ['Not A Code'] }); bad('yes');
  assert.deepEqual(RISK_LEVELS, ['low', 'medium', 'high', 'critical']);
});

test('the rollout bucket is the one of @astratra/flags', () => {
  const flags = require('../../flags');
  for (const [seed, id] of [['a', 'u1'], ['conscience:org:routing:main:v2', 'user-77'], ['é', '𝒳']]) assert.equal(rolloutBucket(seed, id), flags.bucket(seed, id));
  assert.equal(rolloutBucket('a', ''), null);
});

test('a store that lacks the version methods is refused up front', () => {
  const store = createMemoryGovernorStore();
  delete store.putVersion;
  assert.throws(() => createGovernor(policy(), { store }), { code: 'governor_unavailable' });
});

test('every audit entry of a change carries who, what, when and the versions before and after', async () => {
  const clock = makeClock();
  const governor = createGovernor(policy({ approvers: ['admin-1'] }), { now: clock });
  const at = { organisationId: 'o', kind: 'threshold', id: 'cost' };
  await governor.registerObject({ ...at, content: { max: 3 }, by: { kind: 'human', id: 'admin-1' } });
  await governor.evaluatePolicy({ id: 'p', organisationId: 'o', target: { kind: 'threshold', id: 'cost' }, change: { max: 5 }, proposedBy: { kind: 'engine', id: 'e' } });
  await governor.approveProposal('p', { approver: { kind: 'human', id: 'admin-1' }, organisationId: 'o' });
  clock.advance(1000);
  await governor.stageChange('p', { organisationId: 'o', by: { kind: 'engine', id: 'e' } });
  await governor.deployChange({ ...at, percentage: 100, by: { kind: 'human', id: 'admin-1' } });
  await governor.promoteChange({ ...at, by: { kind: 'human', id: 'admin-1' } });
  await governor.rollbackChange({ ...at, by: { kind: 'human', id: 'admin-1' }, reason: 'test' });
  const entries = await governor.getChangeHistory(at);
  assert.deepEqual(entries.map((e) => e.action), ['rollback', 'promote', 'deploy', 'stage', 'register']);
  for (const entry of entries) {
    assert.ok(entry.at && entry.actor?.id && entry.organisationId === 'o' && entry.objectKind === 'threshold' && entry.objectId === 'cost' && entry.policyVersion, entry.action);
    assert.ok('fromVersion' in entry && 'toVersion' in entry, entry.action);
  }
  assert.deepEqual(entries.map((e) => [e.fromVersion, e.toVersion]), [['v2', 'v1'], ['v1', 'v2'], ['v1', 'v2'], ['v1', 'v2'], [null, 'v1']]);
});

test('a custom onEvent observer sees change events and never alters a decision', async () => {
  const seen = [];
  const governor = createGovernor(policy(), { onEvent: (event) => { seen.push(event.action); throw new Error('observer down'); } });
  await governor.registerObject({ organisationId: 'o', kind: 'routing', id: 'main', content: { model: 'm' }, by: { kind: 'system', id: 's' } });
  assert.deepEqual(seen, ['register']);
});
