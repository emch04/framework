'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGovernor } = require('../src/governor');
const { policy, makeClock } = require('./helpers');

const human = (id) => ({ kind: 'human', id });
const engine = { kind: 'engine', id: 'reflection-engine' };
const system = { kind: 'system', id: 'drift-monitor' };
const model = { kind: 'model', id: 'judge' };
const HOUR = 3600000;
const FAR = '2999-01-01T00:00:00.000Z';

const rich = (extra = {}) => policy({
  approvers: ['admin-1', 'admin-2', 'rev-1', 'ops-1'],
  ...extra,
  approvals: {
    roles: { 'admin-1': ['owner'], 'admin-2': ['owner', 'reviewer'], 'rev-1': ['reviewer'], 'ops-1': ['operator'] },
    matrix: { instructions: { roles: ['owner', 'reviewer'] }, routing: { roles: ['owner'] } },
    floors: { routing: 'high' },
    expiresInMs: HOUR,
    ...extra.approvals
  }
});

/** Advanced governance scenarios against one store: `makeStore()` returns `{ store, cleanup? }`. */
function advancedContract(label, makeStore, options = {}) {
  const suite = (name, fn) => test(`${label}: ${name}`, { skip: options.skip }, async () => {
    const { store, cleanup } = await makeStore();
    try { await fn(store); } finally { await cleanup?.(); }
  });

  function world(store, governorPolicy = rich(), extraOptions = {}) {
    const clock = makeClock();
    const governor = createGovernor(governorPolicy, { store, now: clock, ...extraOptions });
    const org = 'org-a';
    const propose = (id, overrides = {}) => governor.evaluatePolicy({
      id, organisationId: org, target: { kind: 'instructions', id: 'reminders' }, change: { text: `text of ${id}` }, justification: 'Fewer follow-up questions.',
      proposedBy: engine, tests: { total: 12, passed: 12 }, rollback: { restore: 'previous' }, ...overrides
    });
    const approve = (id, who, extra = {}) => governor.approveProposal(id, { approver: human(who), organisationId: org, ...extra });
    const register = (kind = 'instructions', id = 'reminders', content = { text: 'baseline' }, organisationId = org) =>
      governor.registerObject({ organisationId, kind, id, content, by: human('admin-1') });
    const approved = async (id, overrides, who = 'admin-1') => { await propose(id, overrides); return approve(id, who); };
    const stage = (id, by = engine) => governor.stageChange(id, { organisationId: org, by });
    const at = (kind = 'instructions', id = 'reminders') => ({ organisationId: org, kind, id });
    return { clock, governor, org, propose, approve, register, approved, stage, at };
  }

  suite('no deployment without a human approval: pending, declined, rejected, unknown and model-approved proposals cannot be staged', async (store) => {
    const w = world(store);
    await w.register();
    await w.propose('pending');
    await w.propose('declined');
    await w.governor.declineProposal('declined', { approver: human('admin-1'), organisationId: w.org, reasonCode: 'not_needed' });
    await w.propose('rejected', { target: { kind: 'permissions', id: 'agent' } });
    await assert.rejects(w.stage('pending'), { code: 'not_approved' });
    await assert.rejects(w.stage('declined'), { code: 'not_approved' });
    await assert.rejects(w.stage('rejected'), { code: 'not_approved' });
    await assert.rejects(w.stage('missing'), { code: 'not_found' });
    for (const approver of [model, engine, system]) await assert.rejects(w.governor.approveProposal('pending', { approver, organisationId: w.org }), { code: 'approver_not_human' });
    await assert.rejects(w.stage('pending'), { code: 'not_approved' });
    await assert.rejects(w.governor.stageChange('pending', { organisationId: w.org, by: model }), { code: 'actor_not_allowed' });
    assert.deepEqual((await w.governor.listObjects({ organisationId: w.org })).map((o) => o.candidate), [null]);
  });

  suite('a record forced to "approved" in the store is still refused: no approval, a model approval, a forged change', async (store) => {
    const w = world(store);
    await w.register();
    const force = async (id, patch) => { await w.propose(id); await store.transitionProposal(w.org, id, 'pending_approval', { status: 'approved', ...patch }); };
    await force('none', { approvals: [] });
    await assert.rejects(w.stage('none'), { code: 'approval_invalid' });
    await force('by-model', { approvals: [{ approver: model, role: 'owner', at: '2026-10-01T00:00:00.000Z', expiresAt: FAR }] });
    await assert.rejects(w.stage('by-model'), { code: 'approver_not_human' });
    await force('mixed', { approvals: [{ approver: human('admin-1'), role: 'owner', at: '2026-10-01T00:00:00.000Z', expiresAt: FAR }, { approver: model, role: 'reviewer', at: '2026-10-01T00:00:00.000Z', expiresAt: FAR }] });
    await assert.rejects(w.stage('mixed'), { code: 'approver_not_human' });
    await w.approved('forged');
    await store.transitionProposal(w.org, 'forged', 'approved', { change: { text: 'something nobody approved' } });
    await assert.rejects(w.stage('forged'), { code: 'proposal_tampered' });
    await force('stranger', { approvals: [{ approver: human('nobody'), role: 'owner', at: '2026-10-01T00:00:00.000Z', expiresAt: FAR }] });
    await assert.rejects(w.stage('stranger'), { code: 'approver_not_allowed' });
    const invariant = await w.governor.verifyApprovalInvariant({ organisationId: w.org });
    assert.equal(invariant.ok, false);
    assert.ok(invariant.violations.some((v) => v.proposalId === 'by-model' && v.code === 'approver_not_human'));
    assert.equal((await w.governor.getObject(w.at())).candidate, null);
  });

  suite('a proposal touching a protected scope is rejected, and refused again at staging even if forced to approved', async (store) => {
    const w = world(store);
    await w.register();
    const hidden = await w.propose('hidden', { change: { text: 'ok', budgets: { perCycle: 1e9 } } });
    assert.equal(hidden.status, 'rejected');
    await assert.rejects(w.approve('hidden', 'admin-1'), { code: 'not_pending' });
    await store.transitionProposal(w.org, 'hidden', 'rejected', { status: 'approved', approvals: [{ approver: human('admin-1'), role: 'owner', at: '2026-10-01T00:00:00.000Z', expiresAt: FAR }] });
    await assert.rejects(w.stage('hidden'), { code: 'protected_scope' });
    await assert.rejects(w.governor.registerObject({ organisationId: w.org, kind: 'routing', id: 'x', content: { permissions: ['admin'] }, by: human('admin-1') }), { code: 'protected_scope' });
    await assert.rejects(w.governor.registerObject({ organisationId: w.org, kind: 'permissions', id: 'x', content: {}, by: human('admin-1') }), { code: 'not_allowlisted' });
  });

  suite('double approval above a risk: two distinct people, the proposer cannot lower the risk, roles are enforced', async (store) => {
    const w = world(store);
    await w.register(); await w.register('routing', 'main', { model: 'small' });
    const normal = await w.propose('normal');
    assert.deepEqual([normal.risk, normal.requiredApprovals], ['medium', 1]);
    const high = await w.propose('high', { risk: 'high' });
    assert.deepEqual([high.risk, high.requiredApprovals], ['high', 2]);
    const routing = await w.propose('routing', { target: { kind: 'routing', id: 'main' }, change: { model: 'large' }, risk: 'low' });
    assert.deepEqual([routing.risk, routing.requiredApprovals], ['high', 2], 'a declared low risk never lowers the floor of the kind');
    assert.ok((await w.propose('bad-risk', { risk: 'tiny' })).reasons.includes('invalid_proposal'));

    const first = await w.approve('high', 'admin-1');
    assert.equal(first.status, 'pending_approval');
    assert.equal(first.approvals.length, 1);
    await assert.rejects(w.stage('high'), { code: 'not_approved' });
    await assert.rejects(w.approve('high', 'admin-1'), { code: 'already_approved' });
    await assert.rejects(w.approve('high', 'ops-1'), { code: 'approver_role_missing' });
    await assert.rejects(w.approve('high', 'rev-1', { role: 'owner' }), { code: 'approver_role_missing' });
    const second = await w.approve('high', 'rev-1');
    assert.equal(second.status, 'approved');
    assert.deepEqual(second.approvals.map((a) => [a.approver.id, a.role]), [['admin-1', 'owner'], ['rev-1', 'reviewer']]);
    assert.equal((await w.stage('high')).version.versionId, 'v2');

    await assert.rejects(w.approve('routing', 'rev-1'), { code: 'approver_role_missing' });
    await w.approve('routing', 'admin-1');
    assert.equal((await w.approve('routing', 'admin-2')).status, 'approved');

    const actions = (await w.governor.listAudit({ organisationId: w.org, proposalId: 'high' })).filter((e) => e.action === 'approve').map((e) => e.decision);
    assert.deepEqual(actions.sort(), ['approved', 'partial']);
  });

  suite('distinct roles can be demanded for high-risk changes', async (store) => {
    const w = world(store, rich({ approvals: { distinctRoles: true } }));
    await w.register();
    await w.propose('high', { risk: 'high' });
    await w.approve('high', 'admin-1', { role: 'owner' });
    const same = await w.approve('high', 'admin-2', { role: 'owner' });
    assert.equal(same.status, 'pending_approval', 'two owners are two approvals but one role');
    assert.equal((await w.approve('high', 'rev-1', { role: 'reviewer' })).status, 'approved');
  });

  suite('an expired approval is refused; a partial approval that expires no longer counts', async (store) => {
    const w = world(store);
    await w.register();
    await w.approved('late');
    assert.equal((await w.governor.getProposal(w.org, 'late')).approvals[0].expiresAt, new Date(Date.parse('2026-10-01T00:00:00.000Z') + HOUR).toISOString());
    w.clock.advance(HOUR + 1);
    await assert.rejects(w.stage('late'), { code: 'approval_expired' });
    assert.equal((await w.governor.getProposal(w.org, 'late')).status, 'expired');
    await assert.rejects(w.stage('late'), { code: 'approval_expired' });
    await assert.rejects(w.approve('late', 'admin-2'), { code: 'not_pending' });
    assert.ok((await w.governor.listAudit({ organisationId: w.org })).some((e) => e.action === 'expire' && e.proposalId === 'late'));

    await w.propose('double', { risk: 'high' });
    await w.approve('double', 'admin-1');
    w.clock.advance(HOUR + 1);
    const afterExpiry = await w.approve('double', 'rev-1');
    assert.equal(afterExpiry.status, 'pending_approval', 'the first approval expired, the second alone is not enough');
    assert.deepEqual(afterExpiry.approvals.map((a) => a.approver.id), ['rev-1']);
    assert.ok((await w.governor.listAudit({ organisationId: w.org })).some((e) => e.action === 'approval_expired' && e.proposalId === 'double'));
    assert.equal((await w.approve('double', 'admin-1')).status, 'approved');

    await w.approved('unused');
    w.clock.advance(HOUR + 1);
    assert.deepEqual((await w.governor.expireApprovals({ organisationId: w.org })).sort(), ['double', 'unused']);
    assert.equal((await w.governor.getProposal(w.org, 'unused')).status, 'expired');
    const report = await w.governor.morningReport({ organisationId: w.org, since: '2026-10-01T00:00:00.000Z' });
    assert.deepEqual(report.approvedAwaitingStage, []);
  });

  suite('an approval that outlives its window after staging does not undo the candidate', async (store) => {
    const w = world(store);
    await w.register();
    await w.approved('p');
    const staged = await w.stage('p');
    w.clock.advance(10 * HOUR);
    assert.equal((await w.stage('p')).created, false, 'staging twice is the same candidate');
    assert.equal((await w.governor.getObject(w.at())).candidate, staged.version.versionId);
  });

  suite('lifecycle: baseline, stage at 0 %, progressive percentage and cohorts, promote', async (store) => {
    const w = world(store);
    await assert.rejects(w.stage('x'), { code: 'not_found' });
    const base = await w.register();
    assert.equal(base.created, true);
    assert.equal((await w.register()).created, false, 'registering the same baseline twice is one baseline');
    await assert.rejects(w.register('instructions', 'reminders', { text: 'other' }), { code: 'object_exists' });
    await assert.rejects(w.governor.registerObject({ ...w.at(), content: {}, by: engine }), { code: 'actor_not_allowed' });
    await w.approved('p1', { target: { kind: 'instructions', id: 'reminders', version: 'v1' }, change: { text: 'new text' } });
    await assert.rejects(w.governor.stageChange('p1', { organisationId: 'org-b', by: engine }), { code: 'not_found' });
    const staged = await w.stage('p1');
    assert.equal(staged.created, true);
    assert.deepEqual([staged.object.stable, staged.object.candidate, staged.object.rollout.percentage], ['v1', 'v2', 0]);
    assert.deepEqual(staged.version.content, { text: 'new text' });
    assert.equal(staged.version.parent, 'v1');
    assert.deepEqual(staged.version.approvedBy.map((a) => a.id), ['admin-1']);

    const ids = Array.from({ length: 300 }, (_, i) => `user-${i}`);
    const served = async () => (await Promise.all(ids.map((targetingKey) => w.governor.resolveVersion({ ...w.at(), targetingKey })))).map((r) => r.source);
    assert.ok((await served()).every((s) => s === 'stable'), 'a staged candidate is served to nobody');
    await assert.rejects(w.governor.deployChange({ ...w.at(), percentage: 30, by: engine }), { code: 'approver_not_human' });
    await assert.rejects(w.governor.deployChange({ ...w.at(), percentage: 130, by: human('admin-1') }), { code: 'invalid_rollout' });
    await assert.rejects(w.governor.deployChange({ ...w.at(), percentage: 30, by: human('stranger') }), { code: 'approver_not_allowed' });
    await w.governor.deployChange({ ...w.at(), percentage: 30, by: human('admin-1') });
    const at30 = await served();
    const share = at30.filter((s) => s === 'candidate').length / ids.length;
    assert.ok(share > 0.18 && share < 0.42, `about 30 % (${share})`);
    assert.deepEqual(await served(), at30, 'deterministic');
    assert.equal((await w.governor.resolveVersion({ ...w.at() })).source, 'stable', 'no identity, no candidate');
    await w.governor.deployChange({ ...w.at(), percentage: 60, by: human('admin-1') });
    const at60 = await served();
    assert.ok(at30.every((s, i) => s !== 'candidate' || at60[i] === 'candidate'), 'growing never removes someone');
    await assert.rejects(w.governor.promoteChange({ ...w.at(), by: human('admin-1') }), { code: 'rollout_incomplete' });
    await w.governor.deployChange({ ...w.at(), percentage: 100, cohorts: ['beta'], by: human('admin-1') });
    const cohort = (targetingKey, c) => w.governor.resolveVersion({ ...w.at(), targetingKey, attributes: { cohort: c } });
    assert.equal((await cohort('user-1', 'beta')).source, 'candidate');
    assert.equal((await cohort('user-1', 'other')).source, 'stable');
    await assert.rejects(w.governor.promoteChange({ ...w.at(), by: human('admin-1') }), { code: 'rollout_incomplete' }, 'a cohort is not everyone');
    await w.governor.deployChange({ ...w.at(), cohorts: [], by: human('admin-1') });
    assert.ok((await served()).every((s) => s === 'candidate'));
    await assert.rejects(w.governor.promoteChange({ ...w.at(), by: engine }), { code: 'approver_not_human' });
    const promoted = await w.governor.promoteChange({ ...w.at(), by: human('admin-1') });
    assert.deepEqual([promoted.stable, promoted.candidate, promoted.stableHistory], ['v2', null, ['v1', 'v2']]);
    assert.deepEqual((await w.governor.resolveVersion({ ...w.at(), targetingKey: 'user-1' })).content, { text: 'new text' });
    assert.deepEqual((await w.governor.listVersions(w.at())).map((v) => [v.versionId, v.status]), [['v1', 'previous'], ['v2', 'stable']]);
    await assert.rejects(w.stage('p1'), { code: 'already_staged' });

    const history = await w.governor.getChangeHistory(w.at());
    assert.deepEqual(history.map((e) => e.action).reverse(), ['register', 'stage', 'deploy', 'deploy', 'deploy', 'deploy', 'promote']);
    const promote = history[0];
    assert.deepEqual([promote.fromVersion, promote.toVersion, promote.actor, promote.organisationId], ['v1', 'v2', human('admin-1'), w.org]);
    assert.ok(promote.at && promote.policyVersion);
    const staging = history.find((e) => e.action === 'stage');
    assert.deepEqual([staging.proposalId, staging.fromVersion, staging.toVersion, staging.actor], ['p1', 'v1', 'v2', engine]);
    assert.ok((await w.governor.verifyApprovalInvariant({ organisationId: w.org })).ok);
  });

  suite('one candidate at a time; a proposal built on an old version is stale', async (store) => {
    const w = world(store);
    await w.register();
    await w.approved('one'); await w.approved('two');
    await w.stage('one');
    await assert.rejects(w.stage('two'), { code: 'candidate_exists' });
    await w.governor.rollbackChange({ ...w.at(), by: human('admin-1') });
    await w.approved('based-on-v1', { target: { kind: 'instructions', id: 'reminders', version: 'v9' } });
    await assert.rejects(w.stage('based-on-v1'), { code: 'stale_base' });
  });

  suite('rollback restores exactly the previous version, step by step, and is journaled', async (store) => {
    const w = world(store);
    const baseline = { text: 'baseline', nested: { list: [1, 2, 3] } };
    await w.register('instructions', 'reminders', baseline);
    const before = (await w.governor.listVersions(w.at()))[0];
    for (const [n, id] of [[2, 'first'], [3, 'second']]) {
      await w.approved(id, { change: { text: `change ${n}` } });
      await w.stage(id);
      await w.governor.deployChange({ ...w.at(), percentage: 100, by: human('admin-1') });
      await w.governor.promoteChange({ ...w.at(), by: human('admin-1') });
    }
    assert.equal((await w.governor.getObject(w.at())).stable, 'v3');
    const first = await w.governor.rollbackChange({ ...w.at(), by: human('admin-2'), reason: 'regression' });
    assert.deepEqual([first.mode, first.discardedVersion, first.restoredVersion], ['stable_restored', 'v3', 'v2']);
    assert.deepEqual((await w.governor.resolveVersion({ ...w.at(), targetingKey: 'u' })).content, { text: 'change 2' });
    const second = await w.governor.rollbackChange({ ...w.at(), by: system });
    assert.equal(second.restoredVersion, 'v1');
    const restored = (await w.governor.listVersions(w.at())).find((v) => v.versionId === 'v1');
    assert.deepEqual(restored, { ...before, status: 'stable' }, 'the very same record, not a copy');
    assert.deepEqual((await w.governor.resolveVersion({ ...w.at(), targetingKey: 'u' })).content, baseline);
    await assert.rejects(w.governor.rollbackChange({ ...w.at(), by: system }), { code: 'nothing_to_rollback' });
    await assert.rejects(w.governor.rollbackChange({ ...w.at() }), { code: 'actor_required' });
    const entries = (await w.governor.getChangeHistory(w.at())).filter((e) => e.action === 'rollback');
    assert.deepEqual(entries.map((e) => [e.fromVersion, e.toVersion, e.actor.id, e.reason]), [['v2', 'v1', 'drift-monitor', null], ['v3', 'v2', 'admin-2', 'regression']]);
  });

  suite('rolling back a candidate returns to the stable version at any exposure, by anyone, even under a static halt', async (store) => {
    const w = world(store);
    await w.register();
    await w.approved('p'); await w.stage('p');
    await w.governor.deployChange({ ...w.at(), percentage: 50, by: human('admin-1') });
    const r = await w.governor.rollbackChange({ ...w.at(), by: model, reason: 'bad numbers' });
    assert.deepEqual([r.mode, r.discardedVersion, r.restoredVersion, r.object.candidate, r.object.rollout], ['candidate_discarded', 'v2', 'v1', null, null]);
    const entry = (await w.governor.getChangeHistory(w.at())).find((e) => e.action === 'rollback');
    assert.deepEqual([entry.rolloutBefore, entry.actor, entry.reason], [{ percentage: 50, cohorts: [] }, model, 'bad numbers']);
    await w.approved('q'); await w.stage('q');
    const halted = createGovernor(rich({ halted: true }), { store, now: w.clock });
    await assert.rejects(halted.stageChange('q', { organisationId: w.org, by: engine }), { code: 'governor_halted' });
    const back = await halted.rollbackChange({ ...w.at(), by: system });
    assert.equal(back.mode, 'candidate_discarded');
    assert.equal((await w.governor.getObject(w.at())).candidate, null);
  });

  suite('kill switch: every candidate goes back to stable, globally or for one organisation, and nothing grows while it is on', async (store) => {
    const a = world(store);
    const setup = async (organisationId, kind, id, label) => {
      await a.governor.registerObject({ organisationId, kind, id, content: { text: `stable ${label}` }, by: human('admin-1') });
      await a.governor.evaluatePolicy({ id: `p-${label}`, organisationId, target: { kind, id }, change: { text: `candidate ${label}` }, proposedBy: engine });
      await a.governor.approveProposal(`p-${label}`, { approver: human('admin-1'), organisationId });
      await a.governor.stageChange(`p-${label}`, { organisationId, by: engine });
      await a.governor.deployChange({ organisationId, kind, id, percentage: 100, by: human('admin-1') });
    };
    await setup('org-a', 'instructions', 'one', 'a1');
    await setup('org-a', 'threshold', 'two', 'a2');
    await setup('org-b', 'instructions', 'one', 'b1');
    const candidates = async (organisationId) => (await a.governor.listObjects({ organisationId, hasCandidate: true })).length;
    assert.deepEqual([await candidates('org-a'), await candidates('org-b')], [2, 1]);

    const scoped = await a.governor.halt({ by: system, reason: 'drift', organisationId: 'org-a' });
    assert.equal(scoped.reverted.length, 2);
    assert.deepEqual(scoped.failures, []);
    assert.deepEqual([await candidates('org-a'), await candidates('org-b')], [0, 1], 'another organisation is untouched');
    assert.equal((await a.governor.resolveVersion({ organisationId: 'org-b', kind: 'instructions', id: 'one', targetingKey: 'u' })).source, 'candidate');
    const global = await a.governor.halt({ by: system, reason: 'incident' });
    assert.equal(global.reverted.length, 1);
    assert.deepEqual([await candidates('org-a'), await candidates('org-b')], [0, 0]);
    for (const [org, kind, id] of [['org-a', 'instructions', 'one'], ['org-a', 'threshold', 'two'], ['org-b', 'instructions', 'one']]) {
      const got = await a.governor.resolveVersion({ organisationId: org, kind, id, targetingKey: 'u' });
      assert.deepEqual([got.versionId, got.source, got.content.text.startsWith('stable')], ['v1', 'stable', true]);
    }
    await assert.rejects(a.governor.deployChange({ organisationId: 'org-b', kind: 'instructions', id: 'one', percentage: 10, by: human('admin-1') }), { code: 'governor_halted' });
    await assert.rejects(a.governor.promoteChange({ organisationId: 'org-b', kind: 'instructions', id: 'one', by: human('admin-1') }), { code: 'governor_halted' });
    const emergency = (await a.governor.listAudit({ organisationId: 'org-a' })).filter((e) => e.action === 'emergency_revert');
    assert.equal(emergency.length, 2);
    assert.ok(emergency.every((e) => e.fromVersion === 'v2' && e.toVersion === 'v1' && e.actor.id === 'drift-monitor'));
    await a.governor.resume({ by: human('admin-1') });
    await a.governor.resume({ by: human('admin-1'), organisationId: 'org-a' });
    assert.deepEqual([await candidates('org-a'), await candidates('org-b')], [0, 0], 'resuming does not bring a candidate back');
  });

  suite('a static halt in the policy serves the stable version and refuses every step', async (store) => {
    const w = world(store);
    await w.register(); await w.approved('p'); await w.stage('p');
    await w.governor.deployChange({ ...w.at(), percentage: 100, by: human('admin-1') });
    const halted = createGovernor(rich({ halted: true }), { store, now: w.clock });
    assert.equal((await halted.resolveVersion({ ...w.at(), targetingKey: 'u' })).reason, 'halted');
    assert.equal((await halted.resolveVersion({ ...w.at(), targetingKey: 'u' })).source, 'stable');
    await assert.rejects(halted.deployChange({ ...w.at(), percentage: 10, by: human('admin-1') }), { code: 'governor_halted' });
  });

  suite('stage races: two proposals on one object give one candidate; two simultaneous approvals both count', async (store) => {
    const w = world(store);
    await w.register();
    await w.approved('x'); await w.approved('y');
    const results = await Promise.allSettled([w.stage('x'), w.stage('y')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(['candidate_exists', 'change_conflict'].includes(results.find((r) => r.status === 'rejected').reason.code));
    const both = await Promise.allSettled([w.stage('x'), w.stage('y')]);
    assert.ok(both.some((r) => r.status === 'rejected'));
    assert.equal((await w.governor.listObjects({ organisationId: w.org, hasCandidate: true })).length, 1);

    await w.propose('double', { risk: 'high', target: { kind: 'threshold', id: 'cost' } });
    await Promise.all([w.approve('double', 'admin-1'), w.approve('double', 'ops-1')]);
    const final = await w.governor.getProposal(w.org, 'double');
    assert.equal(final.approvals.length, 2);
    assert.equal(final.status, 'approved');
  });

  suite('the decline reason is a code from a register; declines and governor rejections are readable as signals', async (store) => {
    const w = world(store, rich({ approvals: { declineReasons: ['too_costly'] } }));
    await w.propose('a'); await w.propose('b'); await w.propose('c'); await w.propose('d', { target: { kind: 'permissions', id: 'agent' } });
    const decline = (id, reasonCode) => w.governor.declineProposal(id, { approver: human('admin-1'), organisationId: w.org, reasonCode });
    await assert.rejects(decline('a'), { code: 'decline_reason_required' });
    await assert.rejects(decline('a', 'because I said so'), { code: 'decline_reason_required' });
    await assert.rejects(decline('a', 'too_costly '), { code: 'decline_reason_required' });
    const declined = await decline('a', 'too_costly');
    assert.equal(declined.declineReason, 'too_costly');
    await decline('b', 'poor_tests');
    w.clock.advance(HOUR);
    await decline('c', 'poor_tests');
    const all = await w.governor.listRejectionSignals({ organisationId: w.org });
    assert.deepEqual(all.map((s) => [s.proposalId, s.origin, s.reasonCodes]), [['c', 'human', ['poor_tests']], ['a', 'human', ['too_costly']], ['b', 'human', ['poor_tests']], ['d', 'governor', ['protected_scope', 'not_allowlisted']]]);
    assert.deepEqual((await w.governor.listRejectionSignals({ organisationId: w.org, reasonCode: 'poor_tests' })).map((s) => s.proposalId), ['c', 'b']);
    assert.deepEqual((await w.governor.listRejectionSignals({ organisationId: w.org, origin: 'governor' })).map((s) => s.proposalId), ['d']);
    assert.deepEqual((await w.governor.listRejectionSignals({ organisationId: w.org, since: new Date(Date.parse('2026-10-01T00:00:00.000Z') + HOUR / 2) })).map((s) => s.proposalId), ['c']);
    assert.deepEqual(await w.governor.listRejectionSignals({ organisationId: 'org-b' }), []);
    const entry = (await w.governor.listAudit({ organisationId: w.org, proposalId: 'a' })).find((e) => e.action === 'decline');
    assert.deepEqual([entry.reasonCode, entry.actor], ['too_costly', human('admin-1')]);
  });

  suite('findings: validated, idempotent, isolated, refused while halted', async (store) => {
    const w = world(store);
    const finding = (overrides = {}) => ({ organisationId: w.org, code: 'calibration_gap', severity: 'high', subject: { kind: 'agent', id: 'agent-x' }, decisionIds: ['d1'], evidenceRefs: ['e1'], sampleSize: 40, confidence: 0.8, recordedBy: engine, ...overrides });
    const first = await w.governor.recordFinding(finding());
    assert.equal((await w.governor.recordFinding(finding())).id, first.id);
    for (const bad of [{ code: 'Not a code' }, { severity: 'catastrophic' }, { subject: null }, { confidence: 3 }, { sampleSize: -1 }, { recordedBy: null }]) {
      await assert.rejects(w.governor.recordFinding(finding(bad)), (e) => ['invalid_finding', 'actor_required'].includes(e.code));
    }
    await assert.rejects(w.governor.recordFinding(finding({ organisationId: undefined })), { code: 'organisation_required' });
    assert.equal((await w.governor.listFindings({ organisationId: w.org })).length, 1);
    assert.equal((await w.governor.listFindings({ organisationId: 'org-b' })).length, 0);
    await w.governor.halt({ by: system });
    await assert.rejects(w.governor.recordFinding(finding({ code: 'other_gap' })), { code: 'governor_halted' });
  });

  suite('morning report: complete, deterministic, data only, isolated by organisation', async (store) => {
    const w = world(store);
    const t0 = w.clock();
    await w.register(); await w.register('routing', 'main', { model: 'small' });
    await w.governor.registerObject({ organisationId: 'org-b', kind: 'instructions', id: 'reminders', content: { text: 'other organisation' }, by: human('admin-1') });
    await w.governor.recordFinding({ organisationId: w.org, id: 'old-finding', code: 'tool_failure', severity: 'low', subject: { kind: 'tool', id: 'send' }, recordedBy: engine });
    w.clock.advance(HOUR);
    const since = new Date(w.clock()).toISOString();
    w.clock.advance(HOUR / 2);
    await w.governor.recordFinding({ organisationId: w.org, id: 'f1', code: 'calibration_gap', severity: 'high', subject: { kind: 'agent', id: 'agent-x' }, decisionIds: ['d1', 'd2'], evidenceRefs: ['ev-1'], sampleSize: 60, confidence: 0.7, recordedBy: engine });
    await w.governor.recordFinding({ organisationId: w.org, id: 'f2', code: 'drift', severity: 'medium', subject: { kind: 'tool', id: 'send' }, recordedBy: engine });
    await w.governor.recordFinding({ organisationId: 'org-b', id: 'fb', code: 'secret_org_b_finding', severity: 'critical', subject: { kind: 'agent', id: 'agent-b' }, recordedBy: engine });
    await w.propose('pending-high', { risk: 'high', tests: { total: 20, passed: 20, suite: 'reminders' }, rollback: { restore: 'v1' }, scopes: ['reminders'] });
    await w.propose('pending-bare', { tests: undefined, rollback: undefined, justification: undefined });
    await w.approve('pending-high', 'admin-1');
    await w.propose('declined-one'); await w.governor.declineProposal('declined-one', { approver: human('admin-2'), organisationId: w.org, reasonCode: 'risk_too_high' });
    await w.propose('rejected-one', { change: { tenantId: 'org-z' } });
    await w.governor.evaluatePolicy({ id: 'org-b-proposal', organisationId: 'org-b', target: { kind: 'instructions', id: 'reminders' }, change: { text: 'x' }, proposedBy: engine });
    await w.approved('rolling');
    await w.stage('rolling');
    await w.governor.deployChange({ ...w.at(), percentage: 25, by: human('admin-1') });
    await w.approved('waiting', { target: { kind: 'routing', id: 'main' }, change: { model: 'large' } }, 'admin-1');
    await w.approve('waiting', 'admin-2');

    const until = new Date(w.clock()).toISOString();
    const report = await w.governor.morningReport({ organisationId: w.org, since, until });
    assert.deepEqual(await w.governor.morningReport({ organisationId: w.org, since, until }), report, 'same input, same report');
    assert.equal(report.schema, 'morning-report/1');
    assert.deepEqual([report.organisationId, report.since, report.until, report.halted, report.policyVersion], [w.org, since, until, false, 'test-1']);
    assert.deepEqual(report.findings.items.map((f) => f.id).sort(), ['f1', 'f2'], 'the old finding is outside the period');
    assert.deepEqual(report.findings.bySeverity, { info: 0, low: 0, medium: 1, high: 1, critical: 0 });
    const high = report.pendingProposals.find((p) => p.id === 'pending-high');
    assert.deepEqual([high.risk, high.requiredApprovals, high.approvalsValid, high.hasTests, high.hasRollbackPlan, high.allowedRoles], ['high', 2, 1, true, true, ['owner', 'reviewer']]);
    assert.deepEqual([high.tests, high.rollbackPlan, high.target], [{ total: 20, passed: 20, suite: 'reminders' }, { restore: 'v1' }, { kind: 'instructions', id: 'reminders', version: null }]);
    const bare = report.pendingProposals.find((p) => p.id === 'pending-bare');
    assert.deepEqual([bare.risk, bare.hasTests, bare.hasRollbackPlan, bare.hasJustification, bare.tests], ['medium', false, false, false, null]);
    assert.ok(report.pendingProposals.every((p) => !p.id.includes('org-b')));
    assert.deepEqual(report.rollouts.map((r) => [r.kind, r.id, r.stableVersion, r.candidateVersion, r.percentage, r.proposalId]), [['instructions', 'reminders', 'v1', 'v2', 25, 'rolling']]);
    assert.deepEqual(report.approvedAwaitingStage.map((p) => [p.id, p.risk, p.valid, p.expired]), [['waiting', 'high', true, false]]);
    assert.deepEqual(report.rejections.map((s) => [s.proposalId, s.origin, s.reasonCodes[0]]).sort(), [['declined-one', 'human', 'risk_too_high'], ['rejected-one', 'governor', 'protected_scope']]);
    assert.deepEqual(report.counts, { findings: 2, pending: 2, pendingHighRisk: 1, approvedAwaitingStage: 1, rollouts: 1, rejections: 2, humanRejections: 1, rollbacks: 0 });
    const text = JSON.stringify(report);
    for (const leaked of ['secret_org_b_finding', 'org-b', 'Fewer follow-up questions']) assert.ok(!text.includes(leaked), `${leaked} must not appear`);

    await w.governor.rollbackChange({ ...w.at(), by: human('admin-1'), reason: 'metrics fell' });
    w.clock.advance(60000);
    const after = await w.governor.morningReport({ organisationId: w.org, since });
    assert.deepEqual(after.rollouts, []);
    assert.deepEqual(after.rollbacks.map((r) => [r.kind, r.id, r.fromVersion, r.toVersion, r.mode, r.emergency, r.reason]), [['instructions', 'reminders', 'v2', 'v1', 'candidate_discarded', false, 'metrics fell']]);
    assert.equal(after.counts.rollbacks, 1);

    const other = await w.governor.morningReport({ organisationId: 'org-b', since: new Date(t0).toISOString() });
    assert.deepEqual(other.findings.items.map((f) => f.id), ['fb']);
    assert.deepEqual(other.pendingProposals.map((p) => p.id), ['org-b-proposal']);
    assert.deepEqual([other.rollouts, other.rejections, other.rollbacks, other.approvedAwaitingStage], [[], [], [], []]);
    assert.ok(!JSON.stringify(other).includes('agent-x'));
    await assert.rejects(w.governor.morningReport({ since }), { code: 'organisation_required' });
    await assert.rejects(w.governor.morningReport({ organisationId: w.org, since: 'yesterday-ish' }), { code: 'invalid_period' });
    await assert.rejects(w.governor.morningReport({ organisationId: w.org, since: until, until: since }), { code: 'invalid_period' });
    w.clock.advance(HOUR);
    const empty = await w.governor.morningReport({ organisationId: 'org-c', since });
    assert.equal(empty.counts.pending + empty.counts.findings + empty.counts.rollouts, 0);
  });

  suite('a candidate cannot come from a model approval: the invariant check names a tampered version', async (store) => {
    const w = world(store);
    await w.register();
    await w.approved('p');
    await w.stage('p');
    assert.deepEqual(await w.governor.verifyApprovalInvariant({ organisationId: w.org }), { ok: true, checked: { proposals: 1, versions: 2 }, violations: [] });
    await store.transitionProposal(w.org, 'p', 'approved', { approvals: [{ approver: model, role: 'owner', at: '2026-10-01T00:00:00.000Z', expiresAt: FAR }] });
    const broken = await w.governor.verifyApprovalInvariant({ organisationId: w.org });
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.violations.map((v) => [v.type, v.code]).sort(), [['proposal', 'approver_not_human'], ['version', 'approver_not_human']]);
    assert.equal((await w.governor.verifyApprovalInvariant({ organisationId: 'org-b' })).ok, true);
  });

  suite('an injected flag provider decides who sees the candidate, and the exported rules agree with the built-in rollout', async (store) => {
    const flagsPackage = require('../../flags');
    const w0 = world(store);
    await w0.register(); await w0.approved('p'); await w0.stage('p');
    await w0.governor.deployChange({ ...w0.at(), percentage: 40, cohorts: ['beta'], by: human('admin-1') });
    const exported = await w0.governor.exportFlagRules({ organisationId: w0.org });
    const key = Object.keys(exported.flags)[0];
    assert.deepEqual(Object.keys(exported.flags), ['conscience.org-a.instructions.reminders']);
    assert.deepEqual([exported.flags[key].type, exported.flags[key].rollout, exported.flags[key].target], ['boolean', 40, { cohort: ['beta'] }]);
    const provider = flagsPackage.createFlagProvider({ source: flagsPackage.createMemorySource(exported) });
    const delegated = createGovernor(rich(), { store, now: w0.clock, flags: provider });
    let agree = 0; let candidates = 0;
    for (let i = 0; i < 200; i++) {
      for (const cohort of ['beta', 'other']) {
        const context = { ...w0.at(), targetingKey: `user-${i}`, attributes: { cohort } };
        const a = await delegated.resolveVersion(context);
        const b = await w0.governor.resolveVersion(context);
        assert.equal(a.source, b.source, `${i}/${cohort}`);
        agree += 1; if (a.source === 'candidate') candidates += 1;
      }
    }
    assert.equal(agree, 400);
    assert.ok(candidates > 40 && candidates < 120, `about 40 % of the beta cohort (${candidates})`);
    const broken = createGovernor(rich(), { store, now: w0.clock, flags: { resolveBoolean: async () => { throw new Error('flag service down'); } } });
    assert.equal((await broken.resolveVersion({ ...w0.at(), targetingKey: 'user-1', attributes: { cohort: 'beta' } })).source, 'stable', 'a failing flag service means stable');
    await w0.governor.halt({ by: system });
    assert.equal((await delegated.resolveVersion({ ...w0.at(), targetingKey: 'user-1', attributes: { cohort: 'beta' } })).source, 'stable');
  });

  suite('everything is isolated by organisation', async (store) => {
    const w = world(store);
    await w.register();
    await w.governor.registerObject({ organisationId: 'org-b', kind: 'instructions', id: 'reminders', content: { text: 'b' }, by: human('admin-1') });
    await w.approved('p'); await w.stage('p');
    assert.equal((await w.governor.getObject({ organisationId: 'org-b', kind: 'instructions', id: 'reminders' })).candidate, null);
    assert.equal((await w.governor.listVersions({ organisationId: 'org-b', kind: 'instructions', id: 'reminders' })).length, 1);
    assert.equal(await w.governor.getObject({ organisationId: 'org-c', kind: 'instructions', id: 'reminders' }), null);
    await assert.rejects(w.governor.deployChange({ organisationId: 'org-c', kind: 'instructions', id: 'reminders', percentage: 5, by: human('admin-1') }), { code: 'not_found' });
    await assert.rejects(w.governor.stageChange('p', { organisationId: 'org-b', by: engine }), { code: 'not_found' });
    await assert.rejects(w.governor.listObjects({}), { code: 'organisation_required' });
  });
}

module.exports = { advancedContract };
