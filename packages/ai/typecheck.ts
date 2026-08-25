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

import {
  createDeterministicFallback,
  createMemoryActionStore,
  createPendingActions
} from './src';
import type { DeterministicFallback, PendingAction, PendingActions } from './src';

const actionStore = createMemoryActionStore();

const airlock: PendingActions = createPendingActions({
  store: actionStore,
  tools: {
    send_email: async (payload, { approvedBy }) => void [payload.to, approvedBy]
  },
  onPending: async (action: PendingAction) => void action.description,
  now: () => new Date(),
  logger: { info: () => {}, warn: () => {}, error: () => {} }
});

interface Question { question: string; grades?: number[]; intent?: string }

const fallback: DeterministicFallback<Question> = createDeterministicFallback<Question>({
  responders: {
    average: async ({ grades }) => (grades && grades.length ? { text: String(grades.length) } : null)
  },
  classify: (input) => (input.question.includes('moyenne') ? 'average' : null),
  markDegraded: (answer) => ({ ...answer, degraded: true })
});

async function exercisePending(): Promise<void> {
  const { action } = await airlock.propose({
    action: 'send_email',
    payload: { to: 'x@y.cd' },
    proposedBy: 'agent',
    dedupeKey: 'k'
  });
  const outcome = await airlock.approve(action.id, { approvedBy: 'director', amend: { to: 'z@y.cd' } });
  await airlock.reject(action.id, { rejectedBy: 'director', note: 'non' }).catch(() => null);
  const waiting: PendingAction[] = await airlock.pending();

  const fallen = await fallback.answer({ question: 'sa moyenne ?', grades: [10] });
  const wrapped = await fallback.withFallback(async () => ({ text: 'model' }), { question: 'x' });

  void [outcome.executed, waiting, fallen.handled, wrapped.degraded, airlock.tools, fallback.intents];
}

void exercisePending;
