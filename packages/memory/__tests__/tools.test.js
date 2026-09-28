const { createToolRegistry } = require('@astratra/ai');
const { createMemoryTools } = require('../src');
const { setup } = require('./helpers');

const whereOf = (ctx) => ({ ownerId: ctx.userId, scope: ctx.tenantId });
const alice = { userId: 'alice', tenantId: 't1', userRole: 'member', userName: 'Alice Martin' };
const bob = { userId: 'bob', tenantId: 't1', userRole: 'member' };

function build(extra = {}) {
  const { memory } = setup(extra.memoryOptions || {});
  const tools = createMemoryTools({ memory, roles: ['member'], whereOf, personNameOf: (ctx) => ctx.userName || '', ...extra });
  const registry = createToolRegistry();
  tools.forEach((tool) => registry.register(tool));
  const run = (name, params, ctx) => registry.getToolByName(name).handler(params, ctx);
  return { memory, tools, registry, run };
}

test('the four tools register in @astratra/ai\'s registry for the given roles only', () => {
  const { registry } = build();
  expect(registry.getToolsForRole('member').map((tool) => [tool.name, tool.type])).toEqual([
    ['remember', 'write'], ['recall', 'read'], ['update_memory', 'write'], ['forget', 'write']
  ]);
  expect(registry.getToolsForRole('guest')).toEqual([]);
  expect(registry.formatToolsForPrompt('member')).toContain('goal|preference|fact|person|event|feeling');
});

test('whereOf and roles are required: the tools never guess whose memories they touch', () => {
  const { memory } = setup();
  expect(() => createMemoryTools({ memory, roles: ['member'] })).toThrow(/whereOf/);
  expect(() => createMemoryTools({ memory, whereOf })).toThrow(/roles/);
});

test('remember → recall → update → forget, answered with codes and an undo token', async () => {
  const { run, memory } = build();
  const saved = await run('remember', { text: 'Plans a trip to Japan', kind: 'Goal', importance: '5' }, alice);
  expect(saved).toMatchObject({ ok: true, code: 'memory_saved', memory: { kind: 'goal', importance: 5 } });
  expect(saved.undo).toEqual({ id: saved.memory.id });
  const found = await run('recall', { query: 'trip Japan' }, alice);
  expect(found).toMatchObject({ ok: true, code: 'memories_found' });
  expect(found.memories.map((m) => m.id)).toEqual([saved.memory.id]);
  const fixed = await run('update_memory', { id: saved.memory.id, text: 'Plans a trip to Korea' }, alice);
  expect(fixed).toMatchObject({ ok: true, code: 'memory_corrected', memory: { text: 'Plans a trip to Korea', kind: 'goal', importance: 5 } });
  expect(await run('forget', { id: fixed.memory.id }, alice)).toEqual({ ok: true, code: 'memory_forgotten', id: fixed.memory.id });
  expect(await memory.list(whereOf(alice))).toEqual([]);
});

test('one person\'s tools never read, change or erase another person\'s memories', async () => {
  const { run } = build();
  const saved = await run('remember', { text: 'Keeps bees', kind: 'fact' }, alice);
  expect((await run('recall', { query: 'bees' }, bob)).memories).toEqual([]);
  expect(await run('update_memory', { id: saved.memory.id, text: 'hacked' }, bob)).toEqual({ ok: false, code: 'refused', reason: 'not_found' });
  expect(await run('forget', { id: saved.memory.id }, bob)).toEqual({ ok: false, code: 'refused', reason: 'not_found' });
  expect((await run('recall', { query: 'bees' }, alice)).memories).toHaveLength(1);
});

test('refusals, pause and a switched-off AI come back as reasons; translate adds a message', async () => {
  const translate = jest.fn((key) => `t(${key})`);
  const { run, memory } = build({ translate, isAiEnabled: (ctx) => ctx.userId !== 'bob' });
  expect(await run('remember', { text: '', kind: 'fact' }, alice)).toEqual({ ok: false, code: 'refused', reason: 'empty', message: 't(refused.empty)' });
  expect(await run('remember', { text: 'Keeps bees', kind: 'fact' }, bob)).toMatchObject({ ok: false, reason: 'ai_disabled' });
  await memory.setPaused(whereOf(alice), true);
  expect(await run('remember', { text: 'Keeps bees', kind: 'fact' }, alice)).toMatchObject({ reason: 'paused' });
  expect(await run('update_memory', { id: 'x', text: 'y' }, alice)).toMatchObject({ reason: 'paused' });
  expect(await run('recall', { query: 'x', before: 'garbage' }, alice)).toMatchObject({ ok: false, reason: 'invalid_before' });
});

test('explicit requests and the person\'s own name reach the rules; sources are recorded', async () => {
  const { patternRule } = require('../src');
  const { run, memory } = build({
    memoryOptions: { rules: [patternRule({ code: 'sensitive', patterns: [/asthma/i], allowWhenExplicit: true })], namesOf: async () => ['Alice Martin', 'Bob Stone'] },
    isExplicit: (_params, ctx) => /remember/i.test(ctx.command || ''),
    sourceOf: (_params, ctx) => ({ conversationId: ctx.conversationId })
  });
  expect(await run('remember', { text: 'Has asthma', kind: 'fact' }, alice)).toMatchObject({ reason: 'sensitive' });
  const ok = await run('remember', { text: 'Has asthma', kind: 'fact' }, { ...alice, command: 'Remember I have asthma', conversationId: 'c9' });
  expect(ok.ok).toBe(true);
  expect((await run('remember', { text: 'Alice Martin runs', kind: 'fact' }, alice)).ok).toBe(true);
  expect(await run('remember', { text: 'Bob Stone runs', kind: 'fact' }, alice)).toMatchObject({ reason: 'other_person' });
  const [stored] = (await memory.list(whereOf(alice))).filter((m) => m.text === 'Has asthma');
  expect(stored.source).toMatchObject({ conversationId: 'c9', channel: 'explicit' });
});
