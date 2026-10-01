import {
  createEndpointBreaker,
  createPriceCatalog,
  diffPriceCatalogs,
  normalizeUsage,
  createModelsClient,
  createPm2App,
  createSystemdUnit,
  DEFAULT_LIMITS,
  renderPm2Ecosystem,
  RESULT_CODES,
  serverPaths,
  serviceEnv,
  setupVenvCommand
} from './src';
import type { CallCost, EmbedData, FetchLike, ModelsClient, ModelsResult, ModelsResultCode, Pm2App, PriceCatalog } from './src';

const fakeFetch: FetchLike = async () => ({ status: 200, json: async () => ({}) });

const client: ModelsClient = createModelsClient({
  baseUrl: 'http://127.0.0.1:5007',
  fetch: fakeFetch,
  token: () => 'a-token-read-at-each-call',
  timeouts: { embed: 1500, transcribe: 15000 },
  retry: { attempts: { embed: 3 }, baseDelayMs: 50, retryTimeouts: false },
  breaker: { failureThreshold: 3, recoveryMs: 60_000 },
  limits: { embedMaxBatch: 16 },
  embedModel: 'bge-m3-onnx-int8',
  onEvent: (event) => {
    if (event.type === 'retry') console.log(event.attempt, event.delayMs);
  }
});

const noBreaker = createModelsClient({ fetch: fakeFetch, breaker: false });
const injected = createModelsClient({
  fetch: fakeFetch,
  createBreaker: (endpoint) => createEndpointBreaker({ name: endpoint, failureThreshold: 5 })
});

async function use(): Promise<void> {
  const embedded: ModelsResult<EmbedData> = await client.embed(['a'], { timeoutMs: 500 });
  if (embedded.ok) {
    const first: number[] = embedded.vectors[0];
    const model: string = embedded.model;
    console.log(first.length, model, embedded.dimensions);
  } else {
    const code: ModelsResultCode = embedded.code;
    const retry: boolean = embedded.retryable;
    console.log(code, retry);
  }
  const ranked = await client.rerank('q', ['a', 'b']);
  if (ranked.ok) console.log(ranked.scores[0]);
  const inferred = await client.nli([{ premise: 'p', hypothesis: 'h' }]);
  if (inferred.ok) console.log(inferred.results[0].contradiction);
  const found = await client.entities('Ada Lovelace', ['person']);
  if (found.ok) console.log(found.entities[0]?.start);
  await client.entities('Ada Lovelace', { timeoutMs: 300 });
  const heard = await client.transcribe(new Uint8Array(32000), { language: null, prompt: 'Ada', vad: true });
  if (heard.ok) console.log(heard.text, heard.noSpeechProb, heard.avgLogprob);
  const health = await noBreaker.health();
  if (health.ok) console.log(health.models.embed?.loaded);
  const available: boolean = injected.available('embed');
  console.log(available, injected.breakerStatus('rerank'));
  injected.resetBreakers();
  const embed = client.asMemoryEmbed();
  const { vector, source } = await embed('text');
  console.log(vector.length, source);
}
void use;

const limit: number = DEFAULT_LIMITS.embedMaxBatch;
const codes: readonly ModelsResultCode[] = RESULT_CODES;
console.log(limit, codes.length, serverPaths().app);

const env: Record<string, string> = serviceEnv({ modelsDir: '/srv/models', enabled: ['embed', 'rerank'] });
const app: Pm2App = createPm2App({ python: '/srv/venv/bin/python3', modelsDir: '/srv/models', maxMemoryRestart: '4G' });
const ecosystem: string = renderPm2Ecosystem([app]);
const unit: string = createSystemdUnit({
  python: '/srv/venv/bin/python3',
  user: 'models',
  modelsDir: '/srv/models',
  tokenFile: '/etc/models/token',
  memoryMax: '6G',
  cpuQuota: '400%'
});
const argv: string[] = setupVenvCommand({ venvDir: '/srv/venv', components: ['onnx'] });
console.log(env, ecosystem, unit, argv);

const prices: PriceCatalog = createPriceCatalog({
  overrides: {
    'gemini/gemini-2.5-flash': { billing: 'free_tier' },
    'claude-sonnet-4-5': { pricesPerMillion: { input: 2 }, discount: 0.1 }
  },
  aliases: [{ from: 'rapide', model: 'groq/openai/gpt-oss-120b' }, { match: /^gpt-4o-\d+$/, model: 'gpt-4o' }]
});
const local = createPriceCatalog({
  data: { 'm': { litellm_provider: 'x', input_cost_per_token: 1e-6 } },
  overrides: [{ match: '(?i)^vercel', billing: 'credits', creditPool: 'vercel' }],
  now: () => 0
});
const spent = prices.cost('gemini-2.5-flash', { promptTokenCount: 10, candidatesTokenCount: 5 }, { provider: 'gemini', freeTierExhausted: true });
if (spent.ok) {
  const frozen: CallCost = spent;
  const total: number = frozen.total;
  const list: number | null = frozen.listTotal;
  console.log(total, list, frozen.billing, frozen.unitPrices.input?.perUnit, frozen.computedAt);
} else {
  console.log(spent.code, spent.missing);
}
const info = prices.lookup('openai/gpt-oss-120b', { provider: 'groq' });
if (info.ok) console.log(info.contextWindow.maxInput, info.capabilities.vision, info.tiers[0]?.above);
const window = prices.contextWindow('gpt-4o');
if (window.ok) console.log(window.maxOutput);
const caps = local.capabilities('m');
if (caps.ok) console.log(caps.reasoning);
console.log(normalizeUsage({ input: 1 })?.cacheRead, diffPriceCatalogs({}, {}).added.length, prices.date, prices.size);
