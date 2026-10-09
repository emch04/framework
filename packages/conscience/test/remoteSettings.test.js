'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRemoteSettings, parseRemoteSettings, remotePolicy, createMemoryGovernorStore, GovernorError
} = require('../src/governor');
const { makeClock } = require('./helpers');

const ORG = 'org-a';
const LOCAL = Object.freeze({
  version: 'local-1',
  budgets: { perCycle: 1, perAgent: 5, perOrganisation: 5, periodMs: 86400000 },
  constitution: [{ id: 'identity', description: 'Who the agent is.', protectedScope: 'identity', owner: 'owner' }],
  permissions: { modifiable: ['instructions', 'threshold'] }
});
const settings = (extra = {}) => ({
  schema: 'conscience-settings/1', version: 1, enabled: true, halted: false, resumedBy: null,
  approvers: ['alice', 'bruno'], reflection: { automatic: true, hour: 4, timeZone: 'UTC' }, cyclesPerDay: 2, ...extra
});

/** A source under test control: returns `answer`, or throws when it is an Error. */
function source(initial) {
  const s = { answer: initial, calls: 0 };
  s.read = async () => { s.calls++; if (s.answer instanceof Error) throw s.answer; return s.answer; };
  return s;
}
function setup({ answer = settings(), policy = LOCAL, storage, clock = makeClock() } = {}) {
  const src = source(answer);
  const store = createMemoryGovernorStore();
  const remote = createRemoteSettings({ read: src.read, policy, organisationId: ORG, storage, now: clock });
  return { src, store, remote, clock, governor: () => remote.governor({ store }) };
}
const proposal = (extra = {}) => ({
  organisationId: ORG, target: { kind: 'instructions', id: 'answer_style' }, change: { hint: 'shorter_answers' },
  proposedBy: { kind: 'engine', id: 'reflection' }, risk: 'medium', ...extra
});

test('nothing known: everything off (disabled, halted, nobody can approve)', async () => {
  const { src, remote, governor } = setup({ answer: new Error('offline') });
  const before = remote.current();
  assert.deepEqual([before.source, before.known, before.enabled, before.halted, before.approvers], ['none', false, false, true, []]);
  const outcome = await remote.refresh();
  assert.deepEqual(outcome, { source: 'none', changed: false, error: 'source_unavailable' });
  assert.equal(src.calls, 1);
  const policy = remote.policy();
  assert.equal(policy.halted, true);
  assert.deepEqual(policy.approvers, []);
  assert.equal(await governor().isHalted(ORG), true);
  assert.equal(remote.reflectionDue(Date.parse('2026-10-10T04:30:00Z')), false);
  const results = await remote.applyDecisions(governor(), [{ id: 'd1', proposalId: 'p1', decision: 'approve', approver: { kind: 'human', id: 'alice' } }]);
  assert.deepEqual(results, [{ id: 'd1', proposalId: 'p1', result: 'refused', code: 'settings_unknown' }]);
});

test('valid settings narrow the local policy: approvers, budgets under the local ceilings, nothing else', async () => {
  const { remote, governor } = setup({ answer: settings({ cyclesPerDay: 3 }) });
  assert.deepEqual(await remote.refresh(), { source: 'remote', changed: true, error: null });
  const state = remote.current();
  assert.deepEqual([state.enabled, state.halted, state.approvers, state.cyclesPerDay, state.version], [true, false, ['alice', 'bruno'], 3, 1]);
  const policy = remote.policy();
  assert.deepEqual(policy.budgets, { perCycle: 1, perAgent: 3, perOrganisation: 3, periodMs: 86400000 });
  assert.equal(policy.version, 'local-1.remote-1');
  assert.deepEqual(policy.constitution, LOCAL.constitution);
  assert.deepEqual(policy.permissions, LOCAL.permissions);
  const g = governor();
  assert.equal(await g.isHalted(ORG), false);
  assert.equal(g, governor(), 'same policy, same governor');
  /* A local approver list is a ceiling: remote names outside it are dropped. */
  assert.deepEqual(remotePolicy({ ...LOCAL, approvers: ['alice'] }, parseRemoteSettings(settings())).approvers, ['alice']);
  /* Disabled means halted, whatever else the settings say. */
  assert.equal(remotePolicy(LOCAL, parseRemoteSettings(settings({ enabled: false }))).halted, true);
});

test('source down: the last valid settings stay, in memory and across a restart', async () => {
  const saved = [];
  const storage = { load: async () => saved.at(-1) ?? null, save: async (snapshot) => { saved.push(JSON.parse(JSON.stringify(snapshot))); } };
  const first = setup({ storage });
  await first.remote.refresh();
  assert.equal(saved.length, 1);
  first.src.answer = new Error('timeout');
  assert.deepEqual(await first.remote.refresh(), { source: 'last_known', changed: false, error: 'source_unavailable' });
  assert.deepEqual([first.remote.current().enabled, first.remote.current().approvers], [true, ['alice', 'bruno']]);
  assert.equal(await first.governor().isHalted(ORG), false, 'a silent source does not halt a known agent');
  /* A new process with the source still down starts from the stored settings, not from nothing. */
  const second = setup({ storage, answer: new Error('still down') });
  assert.deepEqual(await second.remote.refresh(), { source: 'last_known', changed: false, error: 'source_unavailable' });
  assert.deepEqual([second.remote.current().known, second.remote.current().enabled], [true, true]);
  /* Same settings again: nothing changes, nothing is saved twice. */
  first.src.answer = settings();
  assert.deepEqual(await first.remote.refresh(), { source: 'remote', changed: false, error: null });
  assert.equal(saved.length, 1);
  /* A broken cache counts as no cache. */
  const broken = setup({ storage: { load: async () => { throw new Error('disk'); }, save: async () => { throw new Error('disk'); } }, answer: new Error('down') });
  await broken.remote.refresh();
  assert.equal(broken.remote.current().source, 'none');
});

test('hostile settings: constitution, protected scopes, permissions and budgets beyond the ceilings are never applied', async () => {
  const hostile = settings({
    version: 2, cyclesPerDay: 900,
    constitution: [], budgets: { perCycle: 1e9, perAgent: 1e9, perOrganisation: 1e9 }, permissions: { modifiable: ['routing'] },
    approvals: { matrix: { default: { approvals: 0 } } }, automaticChanges: 'all', protectedScopes: [], policy: { halted: false }
  });
  const { remote, governor } = setup({ answer: hostile });
  await remote.refresh();
  const state = remote.current();
  assert.deepEqual(state.ignored, ['approvals', 'automaticChanges', 'budgets', 'constitution', 'permissions', 'policy', 'protectedScopes']);
  const policy = remote.policy();
  assert.deepEqual(policy.budgets, { perCycle: 1, perAgent: 5, perOrganisation: 5, periodMs: 86400000 }, 'never above the local ceilings');
  assert.deepEqual(policy.permissions, LOCAL.permissions);
  assert.equal(policy.automaticChanges, undefined);
  const g = governor();
  const rules = g.getPolicy().constitution.map((rule) => rule.id);
  assert.ok(rules.includes('identity') && rules.includes('protect-budgets') && rules.includes('protect-constitution'));
  /* The merged governor still rejects what touches a protected scope or a kind outside the local list. */
  const budgets = await g.evaluatePolicy(proposal({ target: { kind: 'threshold', id: 'budget_cap' }, change: { maxCost: 99 } }));
  assert.equal(budgets.status, 'rejected');
  assert.ok(budgets.reasons.includes('protected_scope'));
  const routing = await g.evaluatePolicy(proposal({ target: { kind: 'routing', id: 'models' }, change: { prefer: 'fast' } }));
  assert.ok(routing.reasons.includes('not_allowlisted'));
  const identity = await g.evaluatePolicy(proposal({ target: { kind: 'instructions', id: 'who' }, scopes: ['identity'] }));
  assert.ok(identity.reasons.includes('protected_scope'));
  /* Spending stops at the local ceiling even with 900 cycles a day asked for. */
  for (let i = 0; i < 5; i++) assert.equal((await g.authorizeSpend({ id: `c${i}`, organisationId: ORG, agentId: 'reflection', cost: 1 })).allowed, true);
  assert.equal((await g.authorizeSpend({ id: 'c6', organisationId: ORG, agentId: 'reflection', cost: 1 })).allowed, false);
});

test('invalid or stale answers keep the last valid settings; a kill switch inside them still applies at once', async () => {
  const { src, remote, governor, store } = setup();
  await remote.refresh();
  for (const bad of ['enabled', null, [], settings({ cyclesPerDay: 1e6 }), settings({ approvers: ['a b'] }), settings({ approvers: 'alice' }),
    settings({ reflection: { automatic: true, hour: 25 } }), settings({ reflection: { automatic: true, hour: 4, timeZone: 'Mars/Olympus' } }),
    settings({ enabled: 'yes' }), settings({ version: -1 }), settings({ schema: 'other/9' })]) {
    src.answer = bad;
    const outcome = await remote.refresh();
    assert.equal(outcome.error, 'invalid_settings', JSON.stringify(bad));
    assert.equal(outcome.source, 'last_known');
    assert.equal(remote.current().enabled, true);
  }
  assert.throws(() => parseRemoteSettings({ enabled: true }), (error) => error instanceof GovernorError && error.code === 'invalid_settings');
  /* Older version than the one in force: ignored. */
  src.answer = settings({ version: 5, cyclesPerDay: 4 });
  await remote.refresh();
  src.answer = settings({ version: 4, cyclesPerDay: 1 });
  assert.equal((await remote.refresh()).error, 'stale_settings');
  assert.equal(remote.current().cyclesPerDay, 4);
  /* An invalid answer that says halted: the halt applies, the rest stays. */
  src.answer = { halted: true, enabled: 'garbled', approvers: 42 };
  const outcome = await remote.refresh();
  assert.deepEqual([outcome.error, outcome.changed], ['invalid_settings', true]);
  assert.equal(remote.current().halted, true);
  assert.equal(remote.current().enabled, false);
  const g = governor();
  assert.equal(await g.isHalted(ORG), true);
  assert.deepEqual(await remote.sync(g), { action: 'halt', halted: true });
  void store;
});

test('remote kill switch: immediate halt (candidates reverted), released only by the human named in the settings', async () => {
  const { src, remote, governor, store } = setup();
  await remote.refresh();
  const g = governor();
  /* A candidate in rollout, to see the emergency revert. */
  const p = await g.evaluatePolicy(proposal());
  await g.approveProposal(p.id, { approver: { kind: 'human', id: 'alice' }, organisationId: ORG });
  await g.registerObject({ organisationId: ORG, kind: 'instructions', id: 'answer_style', content: { v: 1 }, by: { kind: 'system', id: 'boot' } });
  await g.stageChange(p.id, { organisationId: ORG, by: { kind: 'engine', id: 'reflection' } });
  assert.ok((await g.getObject({ organisationId: ORG, kind: 'instructions', id: 'answer_style' })).candidate);

  src.answer = settings({ version: 2, halted: true });
  assert.equal((await remote.refresh()).changed, true);
  const halted = governor();
  assert.notEqual(halted, g, 'the policy changed: a new governor');
  assert.equal(await halted.isHalted(ORG), true);
  assert.deepEqual(await remote.sync(halted), { action: 'halt', halted: true });
  assert.equal(await g.isHalted(ORG), true, 'the old governor shares the store: halted too');
  assert.equal((await g.getObject({ organisationId: ORG, kind: 'instructions', id: 'answer_style' })).candidate, null, 'candidate reverted');
  assert.deepEqual(await remote.sync(halted), { action: 'none', halted: true }, 'idempotent');
  const [entry] = await halted.listAudit({ organisationId: ORG, limit: 50 }).then((list) => list.filter((e) => e.action === 'halt'));
  assert.deepEqual(entry.actor, { kind: 'system', id: 'remote-settings' });

  /* Released without a named human: the halt stays. */
  src.answer = settings({ version: 3, halted: false, resumedBy: null });
  await remote.refresh();
  assert.deepEqual(await remote.sync(governor()), { action: 'none', halted: true, reason: 'resume_needs_human' });
  /* Released by a human: resumed. */
  src.answer = settings({ version: 4, halted: false, resumedBy: 'bruno' });
  await remote.refresh();
  const running = governor();
  assert.deepEqual(await remote.sync(running), { action: 'resume', halted: false });
  assert.equal(await running.isHalted(ORG), false);
  const [resume] = (await running.listAudit({ organisationId: ORG, limit: 50 })).filter((e) => e.action === 'resume');
  assert.deepEqual(resume.actor, { kind: 'human', id: 'bruno' });
  void store;
});

test('a halt pulled by someone else is never released by the remote settings', async () => {
  const { remote, governor } = setup({ answer: settings({ resumedBy: 'alice' }) });
  await remote.refresh();
  const g = governor();
  await g.halt({ by: { kind: 'system', id: 'drift-monitor' }, organisationId: ORG, reason: 'drift' });
  assert.deepEqual(await remote.sync(g), { action: 'none', halted: true, reason: 'halted_by_another_actor' });
  assert.equal(await g.isHalted(ORG), true);
});

test('replaying an approval: applied once, then already_applied; declines too; the governor keeps its checks', async () => {
  const { remote, governor } = setup();
  await remote.refresh();
  const g = governor();
  const p1 = await g.evaluatePolicy(proposal());
  const p2 = await g.evaluatePolicy(proposal({ target: { kind: 'threshold', id: 'confidence' }, change: { min: 0.6 } }));
  const p3 = await g.evaluatePolicy(proposal({ target: { kind: 'instructions', id: 'answer_focus' }, change: { hint: 'stay_on_question' } }));
  const decisions = [
    { id: 'd1', proposalId: p1.id, decision: 'approve', approver: { kind: 'human', id: 'alice' } },
    { id: 'd2', proposalId: p2.id, decision: 'decline', approver: { kind: 'human', id: 'bruno' }, reasonCode: 'risk_too_high' }
  ];
  assert.deepEqual((await remote.applyDecisions(g, decisions)).map((r) => [r.id, r.result, r.code]), [['d1', 'applied', null], ['d2', 'applied', null]]);
  assert.deepEqual((await remote.applyDecisions(governor(), decisions)).map((r) => [r.id, r.result, r.code]), [['d1', 'already_applied', null], ['d2', 'already_applied', null]]);
  const approved = await g.getProposal(ORG, p1.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvals.length, 1, 'one approval, not two');
  assert.equal((await g.getProposal(ORG, p2.id)).declineReason, 'risk_too_high');
  const approvals = (await g.listAudit({ organisationId: ORG, limit: 100 })).filter((e) => e.action === 'approve');
  assert.equal(approvals.length, 1);

  const refused = await remote.applyDecisions(g, [
    { id: 'd3', proposalId: p3.id, decision: 'approve', approver: { kind: 'human', id: 'mallory' } },
    { id: 'd4', proposalId: p3.id, decision: 'approve', approver: { kind: 'model', id: 'alice' } },
    { id: 'd5', proposalId: p3.id, decision: 'decline', approver: { kind: 'human', id: 'alice' } },
    { id: 'd6', proposalId: p2.id, decision: 'approve', approver: { kind: 'human', id: 'alice' } },
    { id: 'd7', proposalId: 'missing', decision: 'approve', approver: { kind: 'human', id: 'alice' } }
  ]);
  assert.deepEqual(refused.map((r) => [r.id, r.result, r.code]), [
    ['d3', 'refused', 'approver_not_allowed'], ['d4', 'refused', 'invalid_decision'], ['d5', 'refused', 'invalid_decision'],
    ['d6', 'refused', 'not_pending'], ['d7', 'refused', 'not_found']
  ]);
  assert.equal((await g.getProposal(ORG, p3.id)).status, 'pending_approval');
});

test('halted: approvals refused by the governor, declines still recorded; a broken store fails without acknowledging', async () => {
  const { src, remote, governor } = setup();
  await remote.refresh();
  const p = await governor().evaluatePolicy(proposal());
  src.answer = settings({ version: 2, halted: true });
  await remote.refresh();
  const g = governor();
  const [approve] = await remote.applyDecisions(g, [{ id: 'd1', proposalId: p.id, decision: 'approve', approver: { kind: 'human', id: 'alice' } }]);
  assert.deepEqual([approve.result, approve.code], ['refused', 'governor_halted']);
  const [decline] = await remote.applyDecisions(g, [{ id: 'd2', proposalId: p.id, decision: 'decline', approver: { kind: 'human', id: 'alice' }, reasonCode: 'bad_timing' }]);
  assert.equal(decline.result, 'applied');
  const broken = { approveProposal: async () => { throw new Error('connection reset'); }, declineProposal: async () => { throw new Error('connection reset'); } };
  const [failed] = await remote.applyDecisions(broken, [{ id: 'd3', proposalId: 'p', decision: 'approve', approver: { kind: 'human', id: 'alice' } }]);
  assert.deepEqual([failed.result, failed.code], ['failed', 'governor_unavailable']);
});

test('reflection schedule: local hour of the configured time zone, one cycle id per local day, never when off', async () => {
  const { src, remote } = setup({ answer: settings({ reflection: { automatic: true, hour: 4, timeZone: 'Europe/Paris' } }) });
  await remote.refresh();
  assert.equal(remote.reflectionDue(Date.parse('2026-10-10T02:15:00Z')), true, '04:15 in Paris (UTC+2)');
  assert.equal(remote.reflectionDue(Date.parse('2026-10-10T04:15:00Z')), false);
  assert.equal(remote.reflectionCycleId(Date.parse('2026-10-09T22:30:00Z')), 'reflection_2026-10-10');
  src.answer = settings({ version: 2, reflection: { automatic: false, hour: 4, timeZone: 'Europe/Paris' } });
  await remote.refresh();
  assert.equal(remote.reflectionDue(Date.parse('2026-10-10T02:15:00Z')), false);
  src.answer = settings({ version: 3, halted: true, reflection: { automatic: true, hour: 4, timeZone: 'Europe/Paris' } });
  await remote.refresh();
  assert.equal(remote.reflectionDue(Date.parse('2026-10-10T02:15:00Z')), false);
});

test('construction refuses what would weaken the governor', () => {
  const read = async () => settings();
  assert.throws(() => createRemoteSettings({ policy: LOCAL, organisationId: ORG }), /read/);
  assert.throws(() => createRemoteSettings({ read, policy: LOCAL }), (error) => error.code === 'organisation_required');
  assert.throws(() => createRemoteSettings({ read, organisationId: ORG }), (error) => error.code === 'policy_missing');
  assert.throws(() => createRemoteSettings({ read, policy: LOCAL, organisationId: ORG, actor: { kind: 'human', id: 'alice' } }), (error) => error.code === 'actor_not_allowed');
  assert.throws(() => remotePolicy(LOCAL, parseRemoteSettings(settings()), { costPerCycle: -1 }), (error) => error.code === 'policy_invalid');
});
