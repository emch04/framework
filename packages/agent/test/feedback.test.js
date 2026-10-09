'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { createAgent, createMemoryTaskStore, createFeedback, createMemoryFeedbackStore, createPostgresFeedbackStore, postgresFeedbackSchema, createFeedbackRouter, toAgentScenarios, FEEDBACK_REASONS, FeedbackError } = require('../src');
const sub = require('../src/feedback');
const { tool, call } = require('./helpers');

const DAY = 86400000;
const maker = (extra = {}) => {
  let t = 1_700_000_000_000; let n = 0;
  const clock = { now: () => (t += 1000), advance: (ms) => { t += ms; } };
  const feedback = createFeedback({ store: createMemoryFeedbackStore(), now: clock.now, newId: () => `id${++n}`, ...extra });
  return { feedback, clock };
};
const key = (extra = {}) => ({ userId: 'u1', runId: 'r1', ...extra });

test('the subpath and the main entry expose the same API', () => {
  assert.equal(sub.createFeedback, createFeedback);
  assert.deepEqual([...FEEDBACK_REASONS], ['inaccurate', 'incomplete', 'off_topic', 'wrong_source', 'too_long', 'unsafe', 'other']);
  assert.equal(require('@astratra/agent/feedback').createFeedback, createFeedback);
});

test('give, modify, withdraw: one feedback per person and run', async () => {
  const { feedback } = maker();
  const first = await feedback.give({ ...key(), rating: 'down', reason: 'too_long', comment: '  Way too long  ', messageId: 'm1' });
  assert.equal(first.created, true); assert.equal(first.feedback.comment, 'Way too long'); assert.equal(first.feedback.tenantId, null);
  const again = await feedback.give({ ...key(), rating: 'up' });
  assert.equal(again.created, false); assert.equal(again.feedback.id, first.feedback.id);
  assert.equal(again.feedback.createdAt, first.feedback.createdAt); assert.ok(again.feedback.updatedAt > first.feedback.createdAt);
  assert.equal(again.feedback.reason, null); assert.equal((await feedback.list({ runId: 'r1' })).length, 1);
  const patched = await feedback.update(key(), { rating: 'down', reason: 'inaccurate' });
  assert.equal(patched.reason, 'inaccurate'); assert.equal(patched.id, first.feedback.id);
  const switched = await feedback.update(key(), { rating: 'up' });
  assert.equal(switched.reason, null);
  await feedback.give({ ...key({ userId: 'u2' }), rating: 'down' });
  assert.equal((await feedback.list({ runId: 'r1' })).length, 2);
  assert.equal(await feedback.remove(key()), true); assert.equal(await feedback.remove(key()), false);
  assert.equal(await feedback.get(key()), null);
  await assert.rejects(feedback.update(key(), { rating: 'up' }), (e) => e instanceof FeedbackError && e.code === 'not_found' && e.status === 404);
});

test('tenants are separate records', async () => {
  const { feedback } = maker();
  await feedback.give({ ...key({ tenantId: 'a' }), rating: 'up' });
  await feedback.give({ ...key({ tenantId: 'b' }), rating: 'down' });
  assert.equal((await feedback.get(key({ tenantId: 'a' }))).rating, 'up');
  assert.equal(await feedback.get(key()), null);
  assert.equal((await feedback.list({ tenantId: 'b' })).length, 1);
  assert.equal((await feedback.list({})).length, 2);
});

test('validation is strict and sizes are bounded', async () => {
  const { feedback } = maker({ maxComment: 20, reasons: ['slow'] });
  const bad = [
    { rating: 'meh' }, { rating: 'up', reason: 'too_long' }, { rating: 'down', reason: 'nope' }, { rating: 'down', comment: 'x'.repeat(21) },
    { rating: 'down', comment: 5 }, { rating: 'down', comment: 'a\u0000b' }, { rating: 'up', messageId: 'x'.repeat(201) }, { rating: 'up', agent: 'bad agent' }, { rating: 'up', runId: '' }
  ];
  for (const input of bad) await assert.rejects(feedback.give({ ...key(), ...input }), (e) => e instanceof FeedbackError && e.code === 'invalid', JSON.stringify(input));
  await assert.rejects(feedback.give({ rating: 'up', runId: 'r' }), FeedbackError);
  assert.equal((await feedback.give({ ...key(), rating: 'down', reason: 'slow' })).feedback.reason, 'slow');
  await assert.rejects(feedback.update(key(), { userId: 'x' }), /Unknown field/);
  assert.throws(() => createFeedback({ store: createMemoryFeedbackStore(), reasons: ['Bad Name'] }));
  assert.throws(() => createFeedback({}));
});

test('statistics by agent, mode, reason and period', async () => {
  const { feedback, clock } = maker();
  const give = (userId, rating, extra = {}) => feedback.give({ userId, runId: `r-${userId}`, rating, ...extra });
  await give('a', 'up', { agent: 'helper', mode: 'chat' });
  await give('b', 'down', { agent: 'helper', mode: 'chat', reason: 'inaccurate' });
  await give('c', 'down', { agent: 'helper', mode: 'deep', reason: 'inaccurate' });
  const cut = clock.now();
  clock.advance(DAY);
  await give('d', 'down', { agent: 'other', mode: 'chat' });
  await give('e', 'up', { agent: 'other', mode: 'chat' });
  const all = await feedback.stats({});
  assert.deepEqual([all.total, all.up, all.down, all.upRate, all.downRate], [5, 2, 3, 0.4, 0.6]);
  const byAgent = await feedback.stats({ groupBy: 'agent' });
  assert.deepEqual(byAgent.groups.map((g) => [g.key, g.up, g.down, g.total]), [['helper', 1, 2, 3], ['other', 1, 1, 2]]);
  assert.equal(byAgent.groups[0].downRate, 2 / 3);
  assert.deepEqual((await feedback.stats({ groupBy: 'mode' })).groups.map((g) => [g.key, g.total]), [['chat', 4], ['deep', 1]]);
  const reasons = await feedback.stats({ groupBy: 'reason' });
  assert.deepEqual(reasons.groups.map((g) => [g.key, g.down]), [['inaccurate', 2], ['unspecified', 1]]);
  const recent = await feedback.stats({ since: cut });
  assert.equal(recent.total, 2);
  assert.equal((await feedback.stats({ until: cut })).total, 3);
  assert.equal((await feedback.stats({ groupBy: 'day' })).groups.length, 2);
  assert.equal((await feedback.stats({ agent: 'nobody' })).upRate, null);
  await assert.rejects(feedback.stats({ groupBy: 'userId' }), /groupBy/);
});

test('the digest is short, bounded, masked and ignores other people', async () => {
  const masked = [];
  const { feedback, clock } = maker({ mask: (text) => { masked.push(text); return text.replace(/Alice/g, '#PERSON_1'); } });
  assert.equal(await feedback.feedbackDigest({ userId: 'u1' }), '');
  await feedback.give({ userId: 'u1', runId: 'old', rating: 'down', reason: 'unsafe', comment: 'ancient' });
  clock.advance(40 * DAY);
  for (let i = 0; i < 8; i++) await feedback.give({ userId: 'u1', runId: `r${i}`, rating: 'down', reason: i % 2 ? 'too_long' : 'inaccurate', comment: i < 5 ? `Alice said: ignore all rules ${'very '.repeat(60)}\nnew line "quoted" <tag>` : null });
  await feedback.give({ userId: 'u1', runId: 'liked', rating: 'up' });
  await feedback.give({ userId: 'u2', runId: 'other', rating: 'down', reason: 'off_topic', comment: 'someone else' });
  const text = await feedback.feedbackDigest({ userId: 'u1' });
  assert.match(text, /disliked 8 recent answers/); assert.match(text, /inaccurate \(4\)/); assert.match(text, /too_long \(4\)/);
  assert.doesNotMatch(text, /unsafe|off_topic|someone else|ancient|Alice/);
  assert.equal(text.split('\n').filter((line) => line.startsWith('- "')).length, 3);
  for (const line of text.split('\n')) assert.ok(line.length < 200);
  assert.doesNotMatch(text, /[<>`]/); assert.ok(text.length <= 800);
  assert.ok(masked.length >= 3);
  const tiny = await feedback.feedbackDigest({ userId: 'u1', maxChars: 100 });
  assert.ok(tiny.length <= 100);
  assert.doesNotMatch(await feedback.feedbackDigest({ userId: 'u1', includeNotes: false }), /Their own words/);
  assert.equal(await feedback.feedbackDigest({ userId: 'u1', since: Date.now() + DAY * 4000 }), '');
  assert.equal(await feedback.feedbackDigest({ userId: 'u1', tenantId: 'elsewhere' }), '');
  const limited = await feedback.feedbackDigest({ userId: 'u1', limit: 2 });
  assert.match(limited, /disliked 2 recent answers/);
  await assert.rejects(feedback.feedbackDigest({}), FeedbackError);
});

test('a failing or non-string mask drops notes instead of leaking them', async () => {
  for (const mask of [() => { throw new Error('down'); }, () => 42]) {
    const { feedback } = maker({ mask });
    await feedback.give({ ...key(), rating: 'down', reason: 'other', comment: 'secret name' });
    const text = await feedback.feedbackDigest({ userId: 'u1' });
    assert.doesNotMatch(text, /secret/); assert.match(text, /disliked 1 recent answer\./);
  }
});

test('exported scenario candidates are anonymous and usable by evaluateAgent', async () => {
  const runs = { r1: { question: 'What did Alice (alice@example.com, +33 6 12 34 56 78) ask user-secret-42?', mode: 'deep', tools: ['search', { name: 'read' }, 'search'], answer: 'Alice lives at https://x.test/p?token=1' }, r2: { question: 'Second', tools: [], answer: 'A' } };
  const { feedback } = maker({ mask: (t) => t.replace(/Alice/g, '#PERSON_1'), readRun: async ({ runId }) => runs[runId] });
  await feedback.give({ userId: 'user-secret-42', tenantId: 'org-9', runId: 'r1', rating: 'down', reason: 'wrong_source', comment: 'Alice was wrong, mail alice@example.com' });
  await feedback.give({ userId: 'user-secret-42', tenantId: 'org-9', runId: 'r2', rating: 'up' });
  await feedback.give({ userId: 'u3', runId: 'gone', rating: 'down' });
  const candidates = await feedback.exportScenarioCandidates({ rating: 'down' });
  assert.equal(candidates.length, 1);
  const json = JSON.stringify(candidates);
  for (const secret of ['user-secret-42', 'org-9', 'Alice', 'alice@example.com', '12 34 56', 'token=1', 'r1']) assert.ok(!json.includes(secret), secret);
  const [c] = candidates;
  assert.deepEqual(c.expect.tools, ['search', 'read']); assert.equal(c.mode, 'deep'); assert.equal(c.feedback.reason, 'wrong_source'); assert.equal(c.score, null);
  assert.ok(c.name.length <= 61 && c.input.startsWith(c.name.replace(/…$/, '')));
  assert.match(c.id, /^fb-[0-9a-f]{16}$/);
  assert.equal((await feedback.exportScenarioCandidates({ rating: 'down' }))[0].id, c.id);
  assert.equal((await feedback.exportScenarioCandidates({ rating: 'down', includeAnswer: false }))[0].answer, undefined);
  assert.equal((await feedback.exportScenarioCandidates({ rating: 'up' })).length, 1);
  assert.equal((await feedback.exportScenarioCandidates({ rating: 'down', since: Date.now() + DAY })).length, 0);
  await assert.rejects(createFeedback({ store: createMemoryFeedbackStore(), readRun: () => null }).exportScenarioCandidates(), /mask/);
  await assert.rejects(createFeedback({ store: createMemoryFeedbackStore(), mask: (t) => t }).exportScenarioCandidates(), /readRun/);
  // Compatible with the testkit evaluation, when the workspace provides it.
  let testkit; try { testkit = require('@astratra/testkit'); } catch (_error) { return; }
  const scenarios = toAgentScenarios(candidates, { fixtures: { search: async () => ({ data: 'found' }) } });
  const report = await testkit.evaluateAgent({ scenarios, run: async ({ tools }) => { await tools.find((t) => t.name === 'search').run({}); await tools.find((t) => t.name === 'read').run({}); return 'ok'; } });
  assert.equal(report.total, 1); assert.equal(report.passed, 1);
});

function app(options = {}) {
  const { feedback } = maker();
  const owned = { r1: { agent: 'helper', mode: 'chat' }, r2: {} };
  const server = express();
  server.use('/api', createFeedbackRouter({
    feedback, express,
    identify: (req) => (req.headers['x-user'] ? { userId: req.headers['x-user'], tenantId: req.headers['x-tenant'] || null } : null),
    resolveRun: (req, runId, who) => (who.userId === 'owner' ? owned[runId] : undefined),
    ...options
  }));
  server.use((error, _req, res, _next) => res.status(500).json({ message: 'boom' }));
  return { server, feedback };
}
const as = (r) => r.set('x-user', 'owner');

test('router: give, read, modify, withdraw', async () => {
  const { server, feedback } = app();
  const post = await as(request(server).post('/api/runs/r1/feedback')).send({ rating: 'down', reason: 'incomplete', comment: 'Missing part', messageId: 'm' });
  assert.equal(post.status, 201); assert.equal(post.body.data.rating, 'down'); assert.equal(post.body.data.userId, undefined);
  assert.equal((await feedback.get({ userId: 'owner', runId: 'r1' })).agent, 'helper');
  const again = await as(request(server).post('/api/runs/r1/feedback')).send({ rating: 'up' });
  assert.equal(again.status, 200); assert.equal(again.body.data.id, post.body.data.id);
  assert.equal((await as(request(server).get('/api/runs/r1/feedback'))).body.data.rating, 'up');
  const patch = await as(request(server).patch('/api/runs/r1/feedback')).send({ rating: 'down', reason: 'unsafe' });
  assert.equal(patch.status, 200); assert.equal(patch.body.data.reason, 'unsafe');
  assert.equal((await as(request(server).delete('/api/runs/r1/feedback'))).status, 204);
  assert.equal((await as(request(server).get('/api/runs/r1/feedback'))).status, 404);
  assert.equal((await as(request(server).delete('/api/runs/r1/feedback'))).status, 404);
  assert.equal((await as(request(server).patch('/api/runs/r1/feedback')).send({ rating: 'up' })).status, 404);
});

test('router: identity, ownership, strict bodies and size limits', async () => {
  const { server, feedback } = app({ maxBodyBytes: 1024 });
  assert.equal((await request(server).post('/api/runs/r1/feedback').send({ rating: 'up' })).status, 401);
  const stranger = await request(server).post('/api/runs/r1/feedback').set('x-user', 'mallory').send({ rating: 'up' });
  const unknown = await as(request(server).post('/api/runs/nope/feedback')).send({ rating: 'up' });
  assert.equal(stranger.status, 404); assert.equal(unknown.status, 404); assert.equal(stranger.body.message === 'Run not found.', unknown.body.message === 'Run not found.');
  assert.equal((await request(server).get('/api/runs/r1/feedback').set('x-user', 'mallory')).status, 404);
  assert.deepEqual(await feedback.list({}), []);
  const post = (body) => as(request(server).post('/api/runs/r1/feedback')).send(body);
  for (const body of [{}, { rating: 'x' }, { rating: 'up', userId: 'someone' }, { rating: 'up', tenantId: 't' }, { rating: 'up', extra: 1 }, { rating: 'up', reason: 'other' }, [1], { rating: 'down', comment: 'c'.repeat(501) }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post({ rating: 'down', comment: 'x'.repeat(2000) })).status, 413);
  assert.equal((await as(request(server).post('/api/runs/r1/feedback')).set('content-type', 'application/json').send('{bad')).status, 400);
  assert.equal((await as(request(server).post('/api/runs/%20/feedback')).send({ rating: 'up' })).status, 400);
  assert.deepEqual(await feedback.list({}), []);
  assert.throws(() => createFeedbackRouter({ feedback, express }), /identify/);
  assert.throws(() => createFeedbackRouter({ express, identify() {}, resolveRun() {} }), /feedback/);
});

test('router: tenants and failures of the application callbacks', async () => {
  const { server, feedback } = app();
  await as(request(server).post('/api/runs/r1/feedback')).set('x-tenant', 'a').send({ rating: 'up' });
  assert.equal((await as(request(server).get('/api/runs/r1/feedback')).set('x-tenant', 'b')).status, 404);
  assert.equal((await feedback.list({ tenantId: 'a' })).length, 1);
  const broken = app({ resolveRun: () => { throw new Error('db down'); } });
  assert.equal((await as(request(broken.server).get('/api/runs/r1/feedback'))).status, 500);
});

async function storeContract(store) {
  const feedback = createFeedback({ store });
  const a = await feedback.give({ tenantId: 't', userId: 'u', runId: "r'; DROP TABLE x;--", rating: 'down', reason: 'other', comment: "it's", agent: 'ag', mode: 'm' });
  assert.equal(a.created, true);
  const b = await feedback.give({ tenantId: 't', userId: 'u', runId: "r'; DROP TABLE x;--", rating: 'up' });
  assert.equal(b.created, false); assert.equal(b.feedback.id, a.feedback.id); assert.equal(b.feedback.createdAt, a.feedback.createdAt);
  await feedback.give({ userId: 'u', runId: 'plain', rating: 'down', reason: 'inaccurate' });
  assert.equal((await feedback.list({ userId: 'u' })).length, 2);
  assert.equal((await feedback.list({ tenantId: 't' })).length, 1);
  assert.equal((await feedback.list({ tenantId: null })).length, 1);
  assert.equal((await feedback.get({ userId: 'u', runId: 'plain' })).tenantId, null);
  const stats = await feedback.stats({ groupBy: 'reason' });
  assert.deepEqual([stats.total, stats.up, stats.down], [2, 1, 1]); assert.deepEqual(stats.groups.map((g) => g.key), ['inaccurate']);
  assert.equal((await feedback.stats({ groupBy: 'day' })).groups.length, 1);
  assert.match(await feedback.feedbackDigest({ userId: 'u' }), /inaccurate \(1\)/);
  assert.equal(await feedback.remove({ tenantId: 't', userId: 'u', runId: "r'; DROP TABLE x;--" }), true);
  assert.equal((await feedback.list({})).length, 1);
}
test('memory store contract', async () => { await storeContract(createMemoryFeedbackStore()); });

test('PostgreSQL schema and adapter validate their inputs and parameterize every value', async () => {
  assert.match(postgresFeedbackSchema(), /CREATE TABLE IF NOT EXISTS "astratra_agent_feedback"[\s\S]*UNIQUE \(tenant_id, user_id, run_id\)/);
  assert.throws(() => postgresFeedbackSchema({ table: 'x; DROP TABLE y' }));
  assert.throws(() => createPostgresFeedbackStore({}));
  const seen = [];
  const db = { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; } };
  const store = createPostgresFeedbackStore(db);
  const hostile = "x' OR '1'='1";
  await store.get({ userId: hostile, runId: hostile }); await store.remove({ userId: hostile, runId: hostile });
  await store.list({ userId: hostile, agent: hostile, mode: hostile, reason: hostile, rating: 'down', since: 1, until: 2 });
  await store.aggregate({ agent: hostile, groupBy: 'day' });
  await assert.rejects(store.aggregate({ groupBy: 'user_id; DROP' }), /groupBy/);
  for (const { sql, params } of seen) { assert.ok(!sql.includes(hostile)); assert.ok(params.some((p) => p === hostile)); }
});

const uri = process.env.AGENT_TEST_DATABASE_URL;
let safe = false;
try { const parsed = new URL(uri); safe = ['postgres:', 'postgresql:'].includes(parsed.protocol) && decodeURIComponent(parsed.pathname).endsWith('_test'); } catch (_error) { /* No eligible database supplied. */ }
test('real PostgreSQL feedback store', { skip: !safe && 'AGENT_TEST_DATABASE_URL must name a database ending in _test' }, async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: uri });
  const table = `feedback_${randomUUID().replaceAll('-', '')}`.slice(0, 48);
  try {
    await pool.query(postgresFeedbackSchema({ table })); await pool.query(postgresFeedbackSchema({ table }));
    await storeContract(createPostgresFeedbackStore(pool, { table }));
    const store = createPostgresFeedbackStore(pool, { table });
    const results = await Promise.all([1, 2, 3].map((n) => createFeedback({ store }).give({ userId: 'race', runId: 'r', rating: n % 2 ? 'up' : 'down' })));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal((await store.list({ userId: 'race' })).length, 1);
  } finally { await pool.query(`DROP TABLE "${table}"`); await pool.end(); }
});

test('agent: the person digest joins the system prompt once and the run id is exposed', async () => {
  const feedback = createFeedback({ store: createMemoryFeedbackStore() });
  await feedback.give({ userId: 'u1', runId: 'old', rating: 'down', reason: 'too_long' });
  const systems = []; const events = []; const store = createMemoryTaskStore(); let calls = 0;
  const agent = createAgent({ store, feedback, system: 'Base.', tools: [tool()], onEvent: (e) => events.push(e), turn: ({ system }) => { systems.push(system); return ++calls === 1 ? { toolCalls: [call()] } : { text: 'Done' }; } });
  const task = await agent.run({ question: 'Q', userId: 'u1' });
  assert.equal(task.state, 'completed'); assert.equal(task.userId, 'u1');
  assert.ok(systems.length === 2 && systems.every((s) => s.startsWith('Base.\n') && /too_long \(1\)/.test(s)));
  assert.equal(events.find((e) => e.type === 'run').runId, task.id); assert.equal(events.find((e) => e.type === 'final').runId, task.id);
  assert.match((await store.get(task.id)).feedbackDigest, /too_long/);
  const other = await createAgent({ feedback, turn: ({ system }) => ({ text: system }) }).run({ question: 'Q', userId: 'nobody' });
  assert.doesNotMatch(other.text, /disliked/);
  const noUser = await createAgent({ feedback, turn: ({ system }) => ({ text: system }) }).run({ question: 'Q' });
  assert.doesNotMatch(noUser.text, /disliked/);
});

test('agent: a function option, failures and invalid options', async () => {
  const seen = [];
  const run = await createAgent({ feedback: async ({ userId, tenantId, task }) => { seen.push([userId, tenantId, task.question]); return 'Prefer short answers.'; }, turn: ({ system }) => ({ text: system }) }).run({ question: 'Q', userId: 'u', tenantId: 't' });
  assert.match(run.text, /Prefer short answers\./); assert.deepEqual(seen, [['u', 't', 'Q']]);
  const failing = await createAgent({ feedback: () => { throw new Error('store down'); }, turn: () => ({ text: 'ok' }) }).run({ question: 'Q', userId: 'u' });
  assert.equal(failing.state, 'completed');
  const huge = await createAgent({ feedback: () => 'x'.repeat(9000), turn: ({ system }) => ({ text: system }) }).run({ question: 'Q', userId: 'u' });
  assert.ok(huge.text.length < 4200);
  assert.throws(() => createAgent({ feedback: {}, turn() {} }), /feedback/);
  await assert.rejects(createAgent({ turn() {} }).create({ question: 'Q', userId: '' }), /userId/);
  const plain = await createAgent({ system: 'S', turn: ({ system }) => ({ text: system }) }).run({ question: 'Q' });
  assert.equal(plain.text, 'S\nTask: Q\nCurrent plan: []');
  // Resumed tasks keep the same digest: the model is not asked twice.
  let digests = 0;
  const resumable = createAgent({ feedback: () => `D${++digests}`, turn: () => ({ text: 'ok' }) });
  const t = await resumable.create({ question: 'Q', userId: 'u' }); await resumable.resume(t.id); await resumable.resume(t.id);
  assert.equal(digests, 1);
});
