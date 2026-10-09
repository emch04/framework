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
