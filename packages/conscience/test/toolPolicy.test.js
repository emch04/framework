'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createToolPolicy, createGovernor, createMemoryGovernorStore, createCalendarBudget, calendarPeriodKey, createMemoryToolBudgetStore,
  TOOL_LEVELS, TOOL_DECISIONS, TOOL_REASONS, GovernorError
} = require('../src/governor');
const { makeClock, policy: governorPolicy } = require('./helpers');
const { toolBudgetContract } = require('./toolBudgetContract');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const human = (id, roles = []) => ({ kind: 'human', id, roles });
const model = { kind: 'model', id: 'assistant' };

/* A generic catalogue: nothing here is specific to any business. */
const tools = () => [
  { name: 'read_item', family: 'alpha', level: 'read', maxPerRun: 3 },
  { name: 'update_item', family: 'alpha', level: 'controlled', validate: (input) => (typeof input?.amount === 'number' ? { ok: true, value: { amount: input.amount } } : { ok: false }), overThreshold: (input, settings) => input.amount > (settings.limits?.amount ?? 100) },
  { name: 'wipe_item', family: 'beta', level: 'sensitive' },
  { name: 'fetch_page', family: 'gamma', level: 'read', budgetExempt: false },
  { name: 'read_state', family: 'gamma', level: 'read', budgetExempt: true }
];

function build(extra = {}) {
  const clock = makeClock();
  const store = createMemoryGovernorStore();
  let settings = { limits: { amount: 100 } };
  const toolPolicy = createToolPolicy({ tools: tools(), store, now: clock, settings: () => settings, pollMs: 0, ...extra });
  return { toolPolicy, store, clock, setSettings: (next) => { settings = next; } };
}

const call = (tool, input = {}, extra = {}) => ({ tool, input, actor: model, organisationId: 'org-a', ...extra });

test('levels: read and controlled calls are allowed, a sensitive one waits for a person', async () => {
  const { toolPolicy } = build();
  const read = await toolPolicy.decide(call('read_item'));
  assert.deepEqual([read.decision, read.allowed, read.code, read.level], [TOOL_DECISIONS.ALLOWED, true, null, TOOL_LEVELS.READ]);
  const update = await toolPolicy.decide(call('update_item', { amount: 10 }));
  assert.equal(update.decision, 'allowed');
  const wipe = await toolPolicy.decide(call('wipe_item'));
  assert.deepEqual([wipe.decision, wipe.code, wipe.allowed], ['pending', TOOL_REASONS.SENSITIVE, false]);
});

test('an unknown tool, an invalid input and a disabled agent are refused with their own code', async () => {
  const { toolPolicy, setSettings } = build();
  assert.equal((await toolPolicy.decide(call('nope'))).code, 'unknown_tool');
  assert.deepEqual([(await toolPolicy.decide(call('update_item', { amount: 'ten' }))).decision, (await toolPolicy.decide(call('update_item', null))).code], ['refused', 'invalid_input']);
  setSettings({ enabled: false });
  const off = await toolPolicy.decide(call('read_item'));
  assert.deepEqual([off.decision, off.code], ['refused', 'disabled']);
});

test('the validator may normalise the input and the policy hands back the normalised one', async () => {
  const { toolPolicy } = build();
  const result = await toolPolicy.decide(call('update_item', { amount: 5, junk: 'x' }));
  assert.deepEqual(result.input, { amount: 5 });
});

test('a disabled family refuses its tools and only its tools; availableTools follows the settings', async () => {
  const { toolPolicy, setSettings } = build();
  setSettings({ families: { alpha: false } });
  assert.equal((await toolPolicy.decide(call('read_item'))).code, 'family_disabled');
  assert.equal((await toolPolicy.decide(call('update_item', { amount: 1 }))).code, 'family_disabled');
  assert.equal((await toolPolicy.decide(call('wipe_item'))).decision, 'pending');
  assert.deepEqual(await toolPolicy.availableTools(), ['wipe_item', 'fetch_page', 'read_state']);
  setSettings({ families: { alpha: true, beta: false, gamma: false } });
  assert.deepEqual(await toolPolicy.availableTools(), ['read_item', 'update_item']);
  setSettings({ enabled: false });
  assert.deepEqual(await toolPolicy.availableTools(), []);
});

test('caps: a number of calls per run, a number per tool, counted at once when calls are asked together', async () => {
  const { toolPolicy, setSettings } = build();
  setSettings({ maxCallsPerRun: 4 });
  const run = toolPolicy.createRun();
  const together = await Promise.all(Array.from({ length: 5 }, () => toolPolicy.decide(call('read_state', {}, { run }))));
  assert.deepEqual(together.map((r) => r.decision), ['allowed', 'allowed', 'allowed', 'allowed', 'refused']);
  assert.equal(together[4].code, 'cap_reached');
  const other = toolPolicy.createRun();
  const perTool = [];
  for (let i = 0; i < 4; i++) perTool.push((await toolPolicy.decide(call('read_item', {}, { run: other }))).decision);
  assert.deepEqual(perTool, ['allowed', 'allowed', 'allowed', 'refused']);
});

test('over a threshold of the tool the call waits; under it, it runs', async () => {
  const { toolPolicy, setSettings } = build();
  assert.equal((await toolPolicy.decide(call('update_item', { amount: 100 }))).decision, 'allowed');
  const over = await toolPolicy.decide(call('update_item', { amount: 101 }));
  assert.deepEqual([over.decision, over.code], ['pending', 'over_threshold']);
  setSettings({ limits: { amount: 500 } });
  assert.equal((await toolPolicy.decide(call('update_item', { amount: 101 }))).decision, 'allowed');
});

test('an untrusted context waits every controlled action, not a read, and the flag can come from the run or the call', async () => {
  const { toolPolicy } = build();
  const run = toolPolicy.createRun();
  assert.equal((await toolPolicy.decide(call('update_item', { amount: 1 }, { run }))).decision, 'allowed');
  run.markUntrusted();
  const held = await toolPolicy.decide(call('update_item', { amount: 1 }, { run }));
  assert.deepEqual([held.decision, held.code], ['pending', 'untrusted_context']);
  assert.equal((await toolPolicy.decide(call('read_item', {}, { run }))).decision, 'allowed');
  const flagged = await toolPolicy.decide(call('update_item', { amount: 1 }, { untrusted: true }));
  assert.equal(flagged.code, 'untrusted_context');
  const strict = build({ untrustedPendingLevels: ['read', 'controlled'] });
  assert.equal((await strict.toolPolicy.decide(call('read_item', {}, { untrusted: true }))).decision, 'pending');
});

test('unreadable settings refuse: nothing passes when the state cannot be read', async () => {
  const broken = createToolPolicy({ tools: tools(), settings: () => { throw new Error('db down'); }, pollMs: 0 });
  assert.deepEqual([(await broken.decide(call('read_item'))).decision, (await broken.decide(call('read_item'))).code], ['refused', 'settings_unavailable']);
  const invalid = createToolPolicy({ tools: tools(), settings: () => ({ enabled: 'yes' }), pollMs: 0 });
  assert.equal((await invalid.decide(call('read_item'))).code, 'settings_unavailable');
  const lostStore = { ...createMemoryGovernorStore(), getControl: async () => { throw new Error('store down'); } };
  const blind = createToolPolicy({ tools: tools(), store: lostStore, pollMs: 0 });
  assert.equal((await blind.decide(call('read_item'))).code, 'settings_unavailable');
});

test('the vocabulary is configurable: levels, decisions and codes come back in the application words', async () => {
  const labels = {
    levels: { read: 'lecture', controlled: 'controlee', sensitive: 'sensible' },
    decisions: { allowed: 'autorisee', pending: 'en_attente', refused: 'refusee' },
    codes: { emergency_stop: 'arret_urgence', family_disabled: 'famille_desactivee', budget_exceeded: 'budget_depasse', cap_reached: 'plafond_atteint', invalid_input: 'entree_invalide', unknown_tool: 'outil_inconnu', disabled: 'agent_inactif' }
  };
  const { toolPolicy } = build({
    labels, untrustedPendingLevels: ['controlee'],
    tools: [{ name: 'lire', family: 'f', level: 'lecture' }, { name: 'agir', family: 'f', level: 'controlee' }, { name: 'effacer', family: 'f', level: 'sensible' }]
  });
  assert.equal((await toolPolicy.decide(call('lire'))).decision, 'autorisee');
  const pending = await toolPolicy.decide(call('effacer'));
  assert.deepEqual([pending.decision, pending.level, pending.reasons], ['en_attente', 'sensible', ['sensitive_tool']]);
  const refused = await toolPolicy.decide(call('inconnu'));
  assert.deepEqual([refused.decision, refused.code, refused.reasons], ['refusee', 'outil_inconnu', ['outil_inconnu']]);
  assert.deepEqual(toolPolicy.listTools().map((t) => t.level), ['lecture', 'controlee', 'sensible']);
  assert.equal((await toolPolicy.decide(call('agir', {}, { untrusted: true }))).decision, 'en_attente');
  assert.throws(() => createToolPolicy({ tools: [{ name: 'a', family: 'f', level: 'read' }], labels: { levels: { read: 'x', controlled: 'x' } } }), { code: 'tool_policy_invalid' });
  assert.throws(() => createToolPolicy({ tools: [{ name: 'a', family: 'f', level: 'read' }], labels: { codes: { not_a_code: 'x' } } }), { code: 'tool_policy_invalid' });
});

test('a policy refuses a wrong catalogue at start', () => {
  const bad = (override) => () => createToolPolicy({ tools: [{ name: 'a', family: 'f', level: 'read', ...override }] });
  assert.throws(bad({ name: '1bad name' }), { code: 'tool_policy_invalid' });
  assert.throws(bad({ level: 'admin' }), { code: 'tool_policy_invalid' });
  assert.throws(bad({ family: '' }), { code: 'tool_policy_invalid' });
  assert.throws(bad({ maxPerRun: 0 }), { code: 'tool_policy_invalid' });
  assert.throws(bad({ estimatedCost: 1.5 }), { code: 'tool_policy_invalid' });
  assert.throws(() => createToolPolicy({ tools: [] }), { code: 'tool_policy_invalid' });
  assert.throws(() => createToolPolicy({ tools: [{ name: 'a', family: 'f', level: 'read' }, { name: 'a', family: 'f', level: 'read' }] }), { code: 'tool_policy_invalid' });
  assert.throws(() => createToolPolicy({ tools: [{ name: 'a', family: 'g', level: 'read' }], families: ['f'] }), { code: 'tool_policy_invalid' });
});

/* ---- calendar budget ---- */

test('calendar period: month and day in a time zone, around midnight and across a month end', () => {
  const instant = Date.parse('2026-10-31T23:30:00.000Z');
  assert.equal(calendarPeriodKey(instant, { period: 'month', timeZone: 'UTC' }), '2026-10');
  assert.equal(calendarPeriodKey(instant, { period: 'month', timeZone: 'Europe/Paris' }), '2026-11');
  assert.equal(calendarPeriodKey(instant, { period: 'day', timeZone: 'Europe/Paris' }), '2026-11-01');
  assert.equal(calendarPeriodKey(instant, { period: 'day', timeZone: 'America/New_York' }), '2026-10-31');
  assert.equal(calendarPeriodKey(Date.parse('2026-12-31T23:30:00.000Z'), { period: 'month', timeZone: 'Europe/Paris' }), '2027-01');
  assert.equal(calendarPeriodKey(new Date(instant), { period: (date, zone) => `${zone}:${date.getUTCFullYear()}` }), 'UTC:2026');
  assert.throws(() => calendarPeriodKey(instant, { period: 'week' }), { code: 'budget_invalid' });
  assert.throws(() => calendarPeriodKey(instant, { timeZone: 'Mars/Olympus' }), { code: 'budget_invalid' });
  assert.throws(() => calendarPeriodKey(Number.NaN), { code: 'budget_invalid' });
  assert.throws(() => createCalendarBudget({ timeZone: 'Mars/Olympus' }), { code: 'budget_invalid' });
});

test('budget: over the cap the call is refused before it starts; the cap is whole units; the refusal is audited', async () => {
  const { toolPolicy, setSettings, store } = build({ budget: { period: 'month', timeZone: 'UTC' } });
  setSettings({ budgetLimit: 1000 });
  assert.equal((await toolPolicy.decide(call('update_item', { amount: 1 }))).decision, 'allowed');
  await toolPolicy.recordSpend({ id: 'm1', amount: 999, organisationId: 'org-a' });
  assert.equal((await toolPolicy.decide(call('update_item', { amount: 1 }))).decision, 'allowed', '999 < 1000: one more call may start');
  await toolPolicy.recordSpend({ id: 'm2', amount: 1, organisationId: 'org-a' });
  const refused = await toolPolicy.decide(call('update_item', { amount: 1 }));
  assert.deepEqual([refused.decision, refused.code], ['refused', 'budget_exceeded']);
  assert.deepEqual([refused.budget.spent, refused.budget.limit, refused.budget.remaining], [1000, 1000, 0]);
  assert.equal((await toolPolicy.decide(call('read_state'))).decision, 'allowed', 'a tool exempt from the budget stays readable');
  assert.equal((await toolPolicy.decide(call('update_item', { amount: 1 }, { organisationId: 'org-b' }))).decision, 'allowed', 'another scope has its own budget');
  const entry = (await store.listAudit({ organisationId: 'org-a', actions: ['tool_decision'] })).find((e) => e.decision === 'refused');
  assert.deepEqual(entry.reasons, ['budget_exceeded']);
  await assert.rejects(toolPolicy.recordSpend({ id: 'frac', amount: 0.5 }), { code: 'budget_invalid' });
  await assert.rejects(toolPolicy.recordSpend({ id: 'neg', amount: -1 }), { code: 'budget_invalid' });
  await assert.rejects(toolPolicy.recordSpend({ amount: 1 }), { code: 'budget_invalid' });
});

test('budget: the estimate of a tool is tested before the call, and a replayed consumption counts once', async () => {
  const { toolPolicy, setSettings } = build({
    budget: {}, tools: [{ name: 'costly', family: 'f', level: 'read', estimatedCost: 300 }, { name: 'cheap', family: 'f', level: 'read' }]
  });
  setSettings({ budgetLimit: 1000 });
  await toolPolicy.recordSpend({ id: 'a', amount: 800 });
  await toolPolicy.recordSpend({ id: 'a', amount: 800 });
  assert.equal((await toolPolicy.budgetStatus()).spent, 800);
  assert.equal((await toolPolicy.decide({ tool: 'costly', input: {} })).code, 'budget_exceeded');
  assert.equal((await toolPolicy.decide({ tool: 'cheap', input: {} })).decision, 'allowed');
});

test('budget across two months in a time zone: the same instants fall in one period in UTC and in two in Paris', async () => {
  const lateOctober = Date.parse('2026-10-31T22:30:00.000Z'); // 23:30 on 31 October in Paris
  const earlyNovember = Date.parse('2026-10-31T23:30:00.000Z'); // 00:30 on 1 November in Paris
  for (const [timeZone, sameMonth] of [['UTC', true], ['Europe/Paris', false]]) {
    const clock = makeClock(lateOctober);
    const { toolPolicy, setSettings } = build({ now: clock, budget: { period: 'month', timeZone, now: clock } });
    setSettings({ budgetLimit: 5000 });
    await toolPolicy.recordSpend({ id: 'oct', amount: 5000, organisationId: 'org-a' });
    assert.equal((await toolPolicy.decide(call('read_item'))).code, 'budget_exceeded', `${timeZone}: the cap is reached in October`);
    clock.advance(earlyNovember - lateOctober);
    const next = await toolPolicy.decide(call('read_item'));
    assert.equal(next.decision, sameMonth ? 'refused' : 'allowed', timeZone);
    const status = await toolPolicy.budgetStatus({ organisationId: 'org-a' });
    assert.equal(status.period, sameMonth ? '2026-10' : '2026-11', timeZone);
    assert.equal(status.spent, sameMonth ? 5000 : 0, timeZone);
    if (!sameMonth) {
      await toolPolicy.recordSpend({ id: 'nov', amount: 200, organisationId: 'org-a' });
      assert.equal((await toolPolicy.budgetStatus({ organisationId: 'org-a' })).spent, 200);
      assert.equal((await toolPolicy.budgetStatus({ at: lateOctober, organisationId: 'org-a' })).spent, 5000, 'October keeps its own total');
    }
  }
});

test('daily budget: the day changes at local midnight', async () => {
  const clock = makeClock(Date.parse('2026-03-14T22:30:00.000Z')); // 23:30 in Paris (CET, +1)
  const budget = createCalendarBudget({ period: 'day', timeZone: 'Europe/Paris', limit: 100, now: clock });
  await budget.record({ id: 'd1', amount: 100 });
  assert.equal((await budget.check()).exceeded, true);
  clock.advance(60 * 60 * 1000); // 00:30 on the 15th
  const fresh = await budget.check();
  assert.deepEqual([fresh.exceeded, fresh.period, fresh.spent], [false, '2026-03-15', 0]);
});

test('budget: a store without the interface is refused at start', () => {
  assert.throws(() => createCalendarBudget({ store: {} }), { code: 'budget_invalid' });
  assert.throws(() => createCalendarBudget({ limit: -1 }), { code: 'budget_invalid' });
  assert.throws(() => createCalendarBudget({ limit: 1.5 }), { code: 'budget_invalid' });
});

toolBudgetContract('memory', async () => ({ store: createMemoryToolBudgetStore() }));

/* ---- kill switch ---- */

test('emergency stop: read before each call, by who may pull it, released by a narrower role, always audited', async () => {
  const { toolPolicy, store } = build({ emergency: { activateRoles: ['owner', 'support'], releaseRoles: ['owner'] } });
  assert.equal((await toolPolicy.decide(call('read_item'))).decision, 'allowed');
  await assert.rejects(toolPolicy.halt({ by: human('nobody', ['guest']), reason: 'x' }), { code: 'actor_not_allowed' });
  await assert.rejects(toolPolicy.halt({ by: null }), { code: 'actor_not_allowed' });
  assert.equal(await toolPolicy.isHalted(), false);
  await toolPolicy.halt({ by: human('sam', ['support']), reason: 'suspicious calls' });
  assert.equal(await toolPolicy.isHalted(), true);
  const refused = await toolPolicy.decide(call('read_item'));
  assert.deepEqual([refused.decision, refused.code], ['refused', 'emergency_stop']);
  assert.equal((await toolPolicy.decide(call('wipe_item'))).code, 'emergency_stop', 'sensitive tools are stopped too, not held');
  await assert.rejects(toolPolicy.resume({ by: human('sam', ['support']) }), { code: 'actor_not_allowed' });
  await assert.rejects(toolPolicy.resume({ by: { kind: 'model', id: 'assistant', roles: ['owner'] } }), { code: 'actor_not_allowed' });
  assert.equal(await toolPolicy.isHalted(), true);
  await toolPolicy.resume({ by: human('olivia', ['owner']) });
  assert.equal((await toolPolicy.decide(call('read_item'))).decision, 'allowed');
  const actions = (await store.listAudit({ limit: 100 })).map((e) => e.action);
  for (const action of ['tool_halt', 'tool_halt_denied', 'tool_resume', 'tool_resume_denied']) assert.ok(actions.includes(action), action);
  const halt = (await store.listAudit({ actions: ['tool_halt'] }))[0];
  assert.deepEqual([halt.actor.id, halt.reasons], ['sam', ['suspicious calls']]);
});

test('emergency stop without roles: anyone with an identity pulls it, only a human lifts it; a stop is scoped by organisation', async () => {
  const { toolPolicy } = build();
  await toolPolicy.halt({ by: model, reason: 'loop detected', organisationId: 'org-a' });
  assert.equal((await toolPolicy.decide(call('read_item'))).code, 'emergency_stop');
  assert.equal((await toolPolicy.decide(call('read_item', {}, { organisationId: 'org-b' }))).decision, 'allowed');
  await assert.rejects(toolPolicy.resume({ by: model, organisationId: 'org-a' }), { code: 'actor_not_allowed' });
  await toolPolicy.resume({ by: human('olivia'), organisationId: 'org-a' });
  assert.equal(await toolPolicy.isHalted('org-a'), false);
  await toolPolicy.halt({ by: human('olivia') });
  assert.equal((await toolPolicy.decide(call('read_item', {}, { organisationId: 'org-b' }))).code, 'emergency_stop');
});

test('emergency stop follows the governor kill switch when one is given', async () => {
  const store = createMemoryGovernorStore();
  const governor = createGovernor(governorPolicy(), { store });
  const { toolPolicy } = build({ governor, store });
  assert.equal((await toolPolicy.decide(call('read_item'))).decision, 'allowed');
  await governor.halt({ by: { kind: 'system', id: 'monitor' }, reason: 'drift' });
  assert.equal((await toolPolicy.decide(call('read_item'))).code, 'emergency_stop');
});

test('emergency stop cuts a slow tool at once: the signal aborts and the call is abandoned even if the tool ignores it', async () => {
  const { toolPolicy, store } = build();
  let sawSignal = null;
  let finished = false;
  const slowAndDeaf = toolPolicy.execute(call('read_item'), async (_input, { signal }) => {
    sawSignal = signal;
    await sleep(2000);
    finished = true;
    return 'late';
  });
  await sleep(30);
  const started = Date.now();
  await toolPolicy.halt({ by: human('olivia'), reason: 'stop everything' });
  const outcome = await slowAndDeaf;
  assert.ok(Date.now() - started < 500, 'the call did not wait for the tool');
  assert.deepEqual([outcome.executed, outcome.interrupted, outcome.decision, outcome.code], [false, true, 'refused', 'emergency_stop']);
  assert.equal(sawSignal.aborted, true);
  assert.equal(sawSignal.reason.code, 'emergency_stop');
  assert.equal(finished, false);
  const kinds = (await store.listAudit({ actions: ['tool_outcome'] })).map((e) => e.decision);
  assert.deepEqual(kinds, ['interrupted']);
  const next = await toolPolicy.execute(call('read_item'), async () => 'never');
  assert.deepEqual([next.executed, next.code, next.interrupted], [false, 'emergency_stop', false]);
});

test('emergency stop pulled by another process is seen while a tool runs (polling), and a stop of another organisation does not cut it', async () => {
  const store = createMemoryGovernorStore();
  const first = build({ store, pollMs: 10 }).toolPolicy;
  const second = build({ store, pollMs: 0 }).toolPolicy;
  const running = first.execute(call('read_item'), (_input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
    setTimeout(() => resolve('done'), 3000).unref();
  }));
  await sleep(30);
  await second.halt({ by: human('olivia'), organisationId: 'org-b' });
  await sleep(60);
  await second.halt({ by: human('olivia'), organisationId: 'org-a' });
  const outcome = await running;
  assert.deepEqual([outcome.interrupted, outcome.code], [true, 'emergency_stop']);
});

test('the caller signal also cuts the tool, and its abort is re-thrown, not taken for a stop', async () => {
  const { toolPolicy } = build();
  const controller = new globalThis.AbortController();
  const running = toolPolicy.execute(call('read_item', {}, { signal: controller.signal }), (_input, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  await sleep(10);
  const reason = new Error('client left');
  controller.abort(reason);
  await assert.rejects(running, (error) => error === reason);
  assert.equal(await toolPolicy.isHalted(), false);
});

test('execute runs allowed tools only: pending and refused calls are never run; failures are audited and re-thrown', async () => {
  const { toolPolicy, store } = build();
  let runs = 0;
  const fn = async (input) => { runs += 1; return { ok: input }; };
  const ok = await toolPolicy.execute(call('update_item', { amount: 3 }), fn);
  assert.deepEqual([ok.executed, ok.result, ok.decision], [true, { ok: { amount: 3 } }, 'allowed']);
  const held = await toolPolicy.execute(call('wipe_item'), fn);
  const over = await toolPolicy.execute(call('update_item', { amount: 1000 }), fn);
  const unknown = await toolPolicy.execute(call('ghost'), fn);
  assert.deepEqual([held.executed, over.executed, unknown.executed, runs], [false, false, false, 1]);
  assert.deepEqual([held.decision, over.decision, unknown.decision], ['pending', 'pending', 'refused']);
  await assert.rejects(toolPolicy.execute(call('read_item'), async () => { throw new TypeError('tool broke'); }), TypeError);
  const outcomes = await store.listAudit({ actions: ['tool_outcome'] });
  assert.deepEqual(outcomes.map((e) => [e.decision, e.reasons]).sort(), [['error', ['TypeError']], ['ok', []]]);
  await assert.rejects(toolPolicy.execute(call('read_item')), { code: 'invalid_call' });
});

/* ---- audit ---- */

test('audit: every decision leaves a record of who, what and why, without the raw input', async () => {
  const events = [];
  const { toolPolicy, store } = build({ onEvent: (event) => events.push(event), version: 'tools-7' });
  const secret = 'card 4111 1111 1111 1111';
  await toolPolicy.decide(call('read_item', { note: secret }));
  await toolPolicy.decide(call('wipe_item', {}, { actor: human('olivia', ['owner']) }));
  await toolPolicy.decide(call('update_item', { amount: 'x' }));
  await toolPolicy.decide({ tool: 'ghost' });
  const entries = (await store.listAudit({ actions: ['tool_decision'], limit: 10 })).reverse();
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((e) => e.decision), ['allowed', 'pending', 'refused', 'refused']);
  assert.deepEqual(entries.map((e) => e.reasons), [[], ['sensitive_tool'], ['invalid_input'], ['unknown_tool']]);
  assert.deepEqual([entries[0].tool, entries[0].family, entries[0].level, entries[0].organisationId, entries[0].policyVersion], ['read_item', 'alpha', 'read', 'org-a', 'tools-7']);
  assert.deepEqual([entries[1].actor.id, entries[1].actor.kind, entries[1].actor.roles], ['olivia', 'human', ['owner']]);
  assert.equal(entries[3].actor, null);
  assert.match(entries[0].inputFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(entries).includes('4111'), 'the raw input never reaches the journal');
  assert.equal(events.length, 4);
  assert.equal(events[0].type, 'tool_policy');
  const decision = await toolPolicy.decide(call('read_item'));
  assert.ok((await store.listAudit({ limit: 1 }))[0].id === decision.auditId);
});

test('audit: an observer that throws changes nothing, and a journal that cannot be written stops the call', async () => {
  const { toolPolicy } = build({ onEvent: () => { throw new Error('observer broke'); } });
  assert.equal((await toolPolicy.decide(call('read_item'))).decision, 'allowed');
  const broken = createToolPolicy({ tools: tools(), store: { ...createMemoryGovernorStore(), appendAudit: async () => { throw new Error('journal down'); } }, pollMs: 0 });
  let ran = false;
  await assert.rejects(broken.execute(call('read_item'), async () => { ran = true; }), /journal down/);
  assert.equal(ran, false);
});

test('the policy writes nothing to the store of the governor besides audit and its own control keys', async () => {
  const store = createMemoryGovernorStore();
  const { toolPolicy } = build({ store });
  await toolPolicy.halt({ by: human('olivia') });
  assert.equal((await store.getControl('tools-halt:*')).halted, true);
  assert.equal(await store.getControl('halt:*'), null);
});

test('GovernorError is the error type of the whole module', async () => {
  const { toolPolicy } = build();
  await assert.rejects(toolPolicy.halt({ by: null }), GovernorError);
  await assert.rejects(toolPolicy.decide(null), GovernorError);
  assert.throws(() => createToolPolicy({}), GovernorError);
});

test('a budget given as a ready-made object works too, and the policy needs a budget before recordSpend', async () => {
  const clock = makeClock();
  const budget = createCalendarBudget({ limit: 10, now: clock });
  const { toolPolicy } = build({ budget });
  await budget.record({ id: 'x', amount: 10, scope: 'org-a' });
  assert.equal((await toolPolicy.decide(call('read_item'))).code, 'budget_exceeded');
  const without = build().toolPolicy;
  assert.throws(() => without.recordSpend({ id: 'x', amount: 1 }), { code: 'budget_invalid' });
});
