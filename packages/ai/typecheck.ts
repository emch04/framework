import {
  createProviderRouter,
  createToolRegistry,
  runAgentLoop
} from '@astratra/ai';

const router = createProviderRouter({
  cooldownMs: 100,
  cooldownJitterMs: 0,
  degradedMs: 1000,
  maxFailures: 2,
  redisKeyPrefix: 'astratra:test',
  intentRouting: {
    chat: { preferred: ['fast'] }
  },
  providers: [{
    id: 'local',
    models: [{
      id: 'fast',
      rpm: 60,
      rpd: 1000,
      tpd: 100000,
      complexity: ['chat', 'agent']
    }],
    call: async (prompt, ctx, model) => `${model.id}:${prompt}:${Boolean(ctx)}`
  }]
});

router.ask('hello', { complexity: 'chat', intent: 'chat', estimatedTokens: 5 }, { requestId: 'req-1' });
const stats = router.getStats();
router.stop();

const registry = createToolRegistry();
const tool = registry.register({
  name: 'lookup',
  description: 'Lookup a record',
  type: 'read',
  roles: ['owner'],
  params: { id: 'string' },
  handler: async (params, ctx) => ({ params, ctx })
});

registry.getToolsForRole('owner');
registry.getToolByName(tool.name);
registry.formatToolsForPrompt('owner');

runAgentLoop({
  prompt: 'answer',
  ctx: { requestId: 'req-1' },
  history: [{ role: 'system', content: 'Be brief' }],
  registry,
  router: {
    ask: async () => 'final answer'
  },
  userRole: 'owner',
  maxSteps: 2
});
void stats;
