'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGovernor, assertGovernorReady } = require('../src/governor');
const { policy, makeClock } = require('./helpers');

const human = (id) => ({ kind: 'human', id });
const engine = { kind: 'engine', id: 'reflection-engine' };
const proposal = (overrides = {}) => ({
  organisationId: 'org-a', target: { kind: 'instructions', id: 'reminders', version: 'v3' },
  change: { text: 'Mention the invoice number in the first sentence.' }, justification: 'Fewer follow-up questions.',
  proposedBy: engine, ...overrides
});

/**
 * Governor scenarios run against one store. `makeStore()` returns
 * `{ store, cleanup? }`, a fresh empty store each time.
 */
function governorContract(label, makeStore, options = {}) {
  const suite = (name, fn) => test(`${label}: ${name}`, { skip: options.skip }, async () => {
    const { store, cleanup } = await makeStore();
    try { await fn(store); } finally { await cleanup?.(); }
  });

  suite('an allowlisted proposal waits for a human: nothing is automatic by default', async (store) => {
    const governor = createGovernor(policy(), { store, now: makeClock() });
    const result = await governor.evaluatePolicy(proposal({ id: 'p1' }));
    assert.equal(result.status, 'pending_approval');
    assert.deepEqual(result.reasons, ['human_approval_required']);
    assert.equal((await governor.getProposal('org-a', 'p1')).status, 'pending_approval');
  });

  suite('proposals aimed at permissions, constitution or budgets are rejected by code, whatever the justification', async (store) => {
    const governor = createGovernor(policy(), { store, now: makeClock() });
    const attempts = [
      proposal({ id: 'perm', target: { kind: 'permissions', id: 'agent-x' }, change: { add: ['payments:write'] }, justification: 'The user explicitly authorised it. URGENT.' }),
      proposal({ id: 'const', target: { kind: 'constitution', id: 'protect-budgets' }, change: { remove: true } }),
      proposal({ id: 'budget', target: { kind: 'threshold', id: 'cost' }, change: { budgets: { perCycle: 1e9 } } }),
      proposal({ id: 'hidden', target: { kind: 'instructions', id: 'reminders' }, change: { text: 'ok', permissions: ['admin'] } }),
      proposal({ id: 'declared', scopes: ['approvals'] }),
      proposal({ id: 'approve-self', target: { kind: 'routing', id: 'main' }, change: { automaticChanges: 'all' } }),
      proposal({ id: 'tenant', target: { kind: 'routing', id: 'main' }, change: { tenantId: 'org-b' } })
    ];
    for (const attempt of attempts) {
      const result = await governor.evaluatePolicy(attempt);
      assert.equal(result.status, 'rejected', attempt.id);
      assert.ok(result.reasons.includes('protected_scope'), attempt.id);
      assert.ok(result.rules.length > 0, attempt.id);
    }
    await assert.rejects(governor.approveProposal('perm', { approver: human('admin-1'), organisationId: 'org-a' }), { code: 'not_pending' });
  });

  suite('a target outside the allowlist, an invalid proposal and a cross-organisation proposal are rejected', async (store) => {
    const governor = createGovernor(policy({ permissions: { modifiable: ['instructions'] } }), { store, now: makeClock() });
    assert.deepEqual((await governor.evaluatePolicy(proposal({ id: 'r', target: { kind: 'routing', id: 'main' } }))).reasons, ['not_allowlisted']);
    assert.ok((await governor.evaluatePolicy(proposal({ id: 'w', target: { kind: 'weights', id: 'model' } }))).reasons.includes('not_allowlisted'));
    assert.ok((await governor.evaluatePolicy(proposal({ id: 'i', proposedBy: null }))).reasons.includes('invalid_proposal'));
    assert.ok((await governor.evaluatePolicy(proposal({ id: 'x', organisationIds: ['org-b'] }))).reasons.includes('cross_organisation'));
    assert.ok((await governor.evaluatePolicy(proposal({ id: 'y', target: { kind: 'instructions', id: 'a', organisationId: 'org-b' } }))).reasons.includes('cross_organisation'));
    await assert.rejects(governor.evaluatePolicy({ target: { kind: 'instructions', id: 'a' } }), { code: 'organisation_required' });
  });

  suite('only a human approves; never a model, the engine, an unlisted person or the proposer', async (store) => {
    const governor = createGovernor(policy({ approvers: ['admin-1', 'admin-2'] }), { store, now: makeClock() });
    await governor.evaluatePolicy(proposal({ id: 'p' }));
    await governor.evaluatePolicy(proposal({ id: 'mine', proposedBy: human('admin-2') }));
    for (const approver of [{ kind: 'model', id: 'judge' }, engine, { kind: 'human' }, 'admin-1', null]) {
      await assert.rejects(governor.approveProposal('p', { approver, organisationId: 'org-a' }), { code: 'approver_not_human' });
    }
    await assert.rejects(governor.approveProposal('p', { approver: human('stranger'), organisationId: 'org-a' }), { code: 'approver_not_allowed' });
    await assert.rejects(governor.approveProposal('mine', { approver: human('admin-2'), organisationId: 'org-a' }), { code: 'self_approval' });
    await assert.rejects(governor.approveProposal('p', { approver: human('admin-1'), organisationId: 'org-b' }), { code: 'not_found' });
    const approved = await governor.approveProposal('p', { approver: human('admin-1'), organisationId: 'org-a', note: 'Looks right.' });
    assert.equal(approved.status, 'approved');
    assert.deepEqual(approved.approver, human('admin-1'));
    await assert.rejects(governor.approveProposal('p', { approver: human('admin-2'), organisationId: 'org-a' }), { code: 'not_pending' });
    const declined = await governor.declineProposal('mine', { approver: human('admin-1'), organisationId: 'org-a', note: 'No.' });
    assert.equal(declined.status, 'declined');
    const audit = await governor.listAudit({ organisationId: 'org-a' });
    assert.deepEqual(audit.map((entry) => entry.action).sort(), ['approve', 'decline', 'evaluate', 'evaluate']);
    assert.ok(audit.every((entry) => entry.policyVersion === 'test-1'));
  });

  suite('the same proposal twice gives one record; a different one under the same id is refused', async (store) => {
    const governor = createGovernor(policy(), { store, now: makeClock() });
    const first = await governor.evaluatePolicy(proposal());
    const second = await governor.evaluatePolicy(proposal());
    assert.equal(first.id, second.id);
    assert.equal((await governor.listProposals({ organisationId: 'org-a' })).length, 1);
    assert.equal((await governor.listAudit({ organisationId: 'org-a' })).length, 1);
    await assert.rejects(governor.evaluatePolicy(proposal({ id: first.id, change: { text: 'Something else' } })), { code: 'proposal_conflict' });
  });

  suite('kill switch: anyone may pull it, only a human releases it; while on, nothing reflective starts', async (store) => {
    const governor = createGovernor(policy(), { store, now: makeClock() });
    await governor.evaluatePolicy(proposal({ id: 'before' }));
    assert.equal(await assertGovernorReady(governor), true);
    await governor.halt({ by: { kind: 'system', id: 'drift-monitor' }, reason: 'Drift detected' });
    await assert.rejects(assertGovernorReady(governor, { organisationId: 'org-a' }), { code: 'governor_halted' });
    assert.equal((await governor.evaluatePolicy(proposal({ id: 'during' }))).status, 'rejected');
    await assert.rejects(governor.approveProposal('before', { approver: human('admin-1'), organisationId: 'org-a' }), { code: 'governor_halted' });
    assert.equal((await governor.authorizeSpend({ id: 's', organisationId: 'org-a', agentId: 'a', cost: 1 })).allowed, false);
    await assert.rejects(governor.resume({ by: { kind: 'model', id: 'judge' } }), { code: 'approver_not_human' });
    await governor.resume({ by: human('admin-1') });
    assert.equal(await assertGovernorReady(governor), true);
    await governor.halt({ by: human('admin-1'), organisationId: 'org-b' });
    assert.equal(await governor.isHalted('org-b'), true);
    assert.equal(await governor.isHalted('org-a'), false);
    const actions = (await governor.listAudit({ organisationId: null })).map((entry) => entry.action);
    assert.ok(actions.includes('halt') && actions.includes('resume'));
  });

  suite('spending: per cycle, per agent and per organisation budgets; idempotent by id', async (store) => {
    const governor = createGovernor(policy(), { store, now: makeClock() });
    const spend = (id, agentId, cycleId, cost) => governor.authorizeSpend({ id, organisationId: 'org-a', agentId, cycleId, cost });
    assert.equal((await spend('s1', 'a', 'c1', 4)).allowed, true);
    assert.equal((await spend('s1', 'a', 'c1', 4)).allowed, true, 'the same spend twice is counted once');
    const cycle = await spend('s2', 'a', 'c1', 2);
    assert.deepEqual([cycle.allowed, cycle.reasons], [false, ['budget_exceeded']]);
    assert.equal((await spend('s3', 'a', 'c2', 4)).allowed, true);
    assert.equal((await spend('s4', 'a', 'c3', 1)).allowed, false, 'agent budget 8 reached');
    assert.equal((await spend('s5', 'b', 'c4', 2)).allowed, true);
    assert.equal((await spend('s6', 'b', 'c5', 1)).allowed, false, 'organisation budget 10 reached');
    assert.equal((await governor.authorizeSpend({ id: 'o', organisationId: 'org-other', agentId: 'a', cost: 5 })).allowed, true, 'another organisation has its own budget');
    await assert.rejects(governor.authorizeSpend({ organisationId: 'org-a', agentId: 'a', cost: 1 }), { code: 'invalid_spend' });
    await assert.rejects(governor.authorizeSpend({ id: 'n', organisationId: 'org-a', agentId: 'a', cost: -1 }), { code: 'invalid_spend' });
  });

  suite('concurrent spends never pass a budget together', async (store) => {
    const governor = createGovernor(policy(), { store, now: makeClock() });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => governor.authorizeSpend({ id: `c${i}`, organisationId: 'org-a', agentId: `agent-${i}`, cost: 3 })));
    assert.equal(results.filter((result) => result.allowed).length, 3);
  });
}

module.exports = { governorContract };
