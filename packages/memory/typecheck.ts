import {
  createMemory,
  createMemoryHandlers,
  createMemoryStore,
  createMemoryTools,
  patternRule,
  runStoreContract,
  worksWithoutAi,
  DEFAULT_KINDS,
  REASONS
} from './src';
import type { ConsolidateResult, Memory, MemoryService, MemoryStore, MemoryToolDefinition, MemoryWhere } from './src';

const store: MemoryStore = createMemoryStore();

const memory: MemoryService = createMemory({
  store,
  kinds: [...DEFAULT_KINDS],
  kindAliases: { objective: 'goal' },
  roleKinds: { learner: ['goal', 'preference'] },
  rules: [patternRule({ code: 'secret', patterns: [/password/i], allowWhenExplicit: false })],
  namesOf: async () => ['Someone Else'],
  embed: async (text, { purpose }) => ({ vector: [text.length, purpose === 'query' ? 1 : 0], source: 'local' }),
  mask: (text) => text,
  llm: async ({ system, prompt }) => `${system}${prompt}`,
  cipher: { encrypt: async (text) => `x${text}`, decrypt: async (value) => value.slice(1) },
  now: () => new Date(),
  generateId: () => 'id',
  logger: { warn: () => undefined },
  maxActive: 300,
  duplicateThreshold: 0.92,
  minSimilarity: null
});

const where: MemoryWhere = { ownerId: 'u1', scope: 'tenant-1' };

async function usage(): Promise<void> {
  const kept = await memory.remember(where, { text: 'Likes tea', kind: 'preference', importance: '4', explicit: true });
  if (kept.ok) {
    const id: string = kept.memory.id;
    const fixed = await memory.update(where, id, { text: 'Likes green tea' }, { personName: 'Me' });
    if (!fixed.ok) void (fixed.reason === REASONS.OTHER_PERSON);
    await memory.undo(where, id);
  }
  const found: Memory[] = await memory.recall(where, { query: 'tea', kinds: ['preference'], limit: 5 });
  const portrait: string = await memory.portrait(where, { maxLength: 1200, masked: true });
  const result: ConsolidateResult = await memory.consolidate(where, { transcript: [{ role: 'user', text: 'hi' }], ref: 'c1' });
  const purged = await memory.purgeOwner('u1');
  void [found, portrait, result.status, purged.memories];

  const tools: MemoryToolDefinition[] = createMemoryTools({
    memory,
    roles: ['member'],
    whereOf: (ctx) => ({ ownerId: String(ctx.userId), scope: String(ctx.tenantId) }),
    translate: (code) => code
  });
  const answer = await tools[0].handler({ text: 'x', kind: 'fact' }, { userId: 'u1' });
  if (answer.ok && answer.code === 'memory_saved') void answer.memory.id;

  const handlers = createMemoryHandlers({ memory, isAiEnabled: async () => false });
  const listed = await handlers.list(where);
  void [listed.paused, worksWithoutAi('erase')];
}

void usage;
void runStoreContract;
