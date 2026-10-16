import { createAgent, createMemoryTaskStore, createPostgresTaskStore, postgresTaskSchema, validatePlan, usageOf, summarizeContext } from './src';
const agent = createAgent({ store: createMemoryTaskStore(), turn: async ({ signal }) => { signal.throwIfAborted(); return { text: 'Done', usage: { inputTokens: 4, outputTokens: 2 } }; }, verify: ({ text }) => ({ complete: text === 'Done' }), onEvent: event => { void event.type; } });
async function exercise() {
  const task = await agent.run({ question: 'Compute a sum.' });
  await agent.resume(task.id);
  await summarizeContext(task.messages, task.plan, { maxChars: 100 }, async () => 'Summary');
  void usageOf({}, { text: 'Done' });
  void validatePlan([{ id: 'step', text: 'Compute', state: 'done' }]);
  void createPostgresTaskStore({ query: async () => ({ rows: [] }) });
  void postgresTaskSchema();
}
void exercise;
import { createGuards } from '@astratra/ai/guards';
const guarded = createAgent({ guards: createGuards({}), tools: [{ name: 'web_search', description: 'Search the web.', parameters: { type: 'object' }, kind: 'read', external: true, run: async () => ({ data: 'x' }) }], turn: () => ({ text: 'Done' }) });
void guarded; void createAgent({ guards: false, turn: () => ({ text: 'Done' }) });
import { createScheduler, createPostgresLock, createPostgresScheduleStore, createApprovalQueue, createPostgresApprovalStore, ApprovalRefused, nextRun } from './src';
const scheduler = createScheduler({ timeZone: 'Europe/Paris', shouldStop: () => false, tasks: [{ id: 'daily', schedule: { type: 'daily', at: '07:00' }, run: ({ signal, previous }) => { signal.throwIfAborted(); void previous; return { ok: true }; } }, { id: 'weekly', schedule: { type: 'weekly', day: 'monday', at: '07:30' }, run: () => {} }, { id: 'every', schedule: { type: 'interval', everyMs: 60000 }, run: async () => {} }] });
void scheduler.tick(); scheduler.start(); scheduler.stop(); void scheduler.run('daily'); void scheduler.state(); void scheduler.state('daily').then((s) => s.nextRunAt);
void nextRun({ type: 'daily', at: '07:00' }, Date.now(), 'Europe/Paris');
const db = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
void createScheduler({ tasks: [], lock: createPostgresLock(db), store: createPostgresScheduleStore(db) });
const queue = createApprovalQueue({ store: createPostgresApprovalStore(db), executors: { send: async ({ input, idempotencyKey, signal }) => { void input; void idempotencyKey; signal.throwIfAborted(); throw new ApprovalRefused('incomplete', { missing: [] }); } }, authorize: ({ decider }) => typeof decider !== 'string' && decider.role === 'owner', onEvent: (e) => { void e.type; } });
void queue.propose({ type: 'send', input: {}, requestedBy: 'agent', ttlMs: 1000 }).then((a) => queue.approve(a.id, { decider: { id: 'u', role: 'owner' } }));
void queue.list({ status: 'pending' }); void queue.expire(); void queue.reject('id', { decider: 'u', reason: 'no' });
