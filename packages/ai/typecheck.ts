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

import { createFormatInstructions, createResponseCleaner, DEFAULT_SURFACES } from './src';
import type { CleanerVocabulary, FormatInstructions, ResponseCleaner } from './src';

const vocabulary: CleanerVocabulary = {
  payloadKeys: ['response'],
  titleKeys: ['title'],
  lineLabels: ['introduction', /key[ _]features/],
  closingPhrases: [/Anything else\?/]
};
const cleaner: ResponseCleaner = createResponseCleaner({ shared: vocabulary, languages: { en: {} }, fallbackLanguage: 'en' });
const cleaned: string = cleaner.clean('{"response": "ok"}', { language: 'en' });
const prose: string = cleaner.jsonToProse({ title: 'x' });

const format: FormatInstructions = createFormatInstructions({
  languages: { en: { paragraphs: 'Write in paragraphs.', table: 'At most {columns} columns.' } },
  surfaces: DEFAULT_SURFACES,
  defaultSurface: 'phone'
});
const rules: string = format.build('mobile', 'en');
void [cleaned, prose, rules, format.normalizeSurface(null)];

import {
  buildPassagesContext,
  createAskLimit,
  createBreakerPool,
  createLanguageDetector,
  createOpenAICompatibleProvider,
  createReversibleMasker,
  createSourceLedger,
  findContradiction,
  isProviderOutage,
  markForeignPassages,
  passageSource,
  plainText,
  rerankResults,
  tidyMarkdown,
  usedSources,
  verifyQuotations,
  withOutboundMasking
} from '@astratra/ai';
import type { BreakerLike, BreakerPool, ReversibleMasker } from '@astratra/ai';

const fakeBreaker = (): BreakerLike => ({ call: async (fn) => fn(), status: () => ({ state: 'closed' }) });
const pool: BreakerPool = createBreakerPool({ create: () => fakeBreaker() });
const masker: ReversibleMasker = createReversibleMasker({
  names: ['Kevin'],
  patterns: [{ type: 'EMAIL', pattern: /@/g }],
  detect: async () => [{ text: 'Grace', type: 'person', score: 0.9 }],
  minScore: 0.6
});
const guardedRouter = createProviderRouter({
  breakers: (id: string) => { void id; return fakeBreaker(); },
  providers: [createOpenAICompatibleProvider({
    id: 'groq', url: 'https://api.test', getKey: () => 'k', models: [{ id: 'm' }],
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), external: true
  })]
});
guardedRouter.ask('hello', {}, { masker });
const circuit: string | null = guardedRouter.getStats()['groq:m']?.circuit ?? null;
guardedRouter.stop();

async function exerciseNew(): Promise<void> {
  const search = withOutboundMasking(masker, async (query: string) => ({ query }));
  await search('Kevin');
  const context: string[] = buildPassagesContext({ passages: [{ title: 'T', text: 'x', lang: 'fr' }], lang: 'en', texts: { foreign: 'Translate {languages}.' } });
  const marked = markForeignPassages([], { lang: 'en' });
  const ledger = createSourceLedger<{ url?: string; title?: string }>();
  ledger.keep([{ url: 'https://a.test' }], 'data');
  const kept = usedSources('answer', ledger.sources(), ledger.evidence(), { commonWords: ['because'] });
  const verdict = await findContradiction('answer', ['source'], { compare: async () => null });
  const reranked = await rerankResults('q', { results: [{ title: 'a' }], sources: [{ url: 'u' }] }, { score: async () => [1] });
  const verified: string = await verifyQuotations('« x » (Loi 1)', { findReferences: () => [], resolve: async () => null });
  const detector = createLanguageDetector({ words: { fr: ['le'], en: ['the'] }, identify: async () => ({ language: 'fr', confidence: 1 }) });
  const language: string = await detector.reply('le', 'en');
  const limit = createAskLimit({ max: 5, windowMs: 60_000, code: 'CHAT_RATE_LIMITED' });
  const verdictLimit = limit.take('u1');
  await runAgentLoop({ prompt: 'x', registry, router: { ask: async () => 'final' }, userRole: 'owner', masker, reportToolErrors: true, toolTimeoutMs: 1000, maxMs: 60_000, finalInstruction: 'Answer now.' });
  void [context, marked.languages, kept, verdict, reranked.results, verified, language, verdictLimit.remaining, circuit,
    pool.stateOf('x'), isProviderOutage(null), passageSource({ text: 'x' }).excerpt, plainText('x'), tidyMarkdown('x', { removeEmoji: true })];
}
void exerciseNew;

/* Le routage d'une demande, les adaptateurs, les outils natifs et le flux (1.5). */
import {
  createGeminiProvider,
  createToolCaller,
  openEventStream,
  runToolLoop,
  searchSerper,
  stepParams,
  toolSpecs,
  validateNativeTools,
  wholeSentences
} from '@astratra/ai';

const routed = createProviderRouter({
  providers: [
    createGeminiProvider({ getKey: (ctx) => String(ctx.key ?? ''), lane: (ctx) => (ctx.purpose === 'news' ? 'news' : null), fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), detailed: true }),
    createOpenAICompatibleProvider({ id: 'groq', url: (ctx) => (ctx.key ? 'https://api.test' : null), getKey: () => 'k', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), detailed: true, toRequest: (request) => request })
  ],
  cooldownOn: (error) => error?.statusCode === 503,
  whenAllCooling: 'try',
  now: () => 0
});
routed.route({ system: 's', messages: [] }, {
  candidates: [{ provider: 'groq', model: 'm', vision: true }],
  select: (model) => model.vision === true,
  accepts: (value) => Boolean(value),
  partial: (value) => Boolean(value?.cut)
}, { purpose: 'news' }).then(({ key, partial }) => `${key}${partial}`);
routed.reset();

const nativeTools = validateNativeTools([{
  name: 'read_bible',
  description: 'Lit un passage.',
  parameters: { type: 'object', properties: {} },
  kind: 'read',
  summary: (args) => ({ reference: String(args.reference ?? '') }),
  run: async () => ({ data: 'lu' })
}], { requireSummary: true });
const callTool = createToolCaller({ tools: nativeTools, emit: (type, data) => `${type}${JSON.stringify(data)}`, onCall: ({ ms }) => ms });
runToolLoop({ system: 's', messages: [], tools: toolSpecs(nativeTools), turn: async () => ({ text: 'ok', toolCalls: [] }), callTool, finalInstruction: 'Réponds.' })
  .then(({ text, turns }) => `${text}${turns}`);
const params: Record<string, string | number> = stepParams(nativeTools[0], { reference: 'Jean 3:16' });
const sentence: string = wholeSentences('Une phrase. Coup');
searchSerper({ query: 'q', sites: ['jw.org'] }, { key: 'k', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }).then((results) => results.map((result) => result.url));
declare const serverResponse: Parameters<typeof openEventStream>[0];
openEventStream(serverResponse).send('answer', { text: `${params.reference}${sentence}` });
