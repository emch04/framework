'use strict';

const { createProviderRouter } = require('./providerRouter');
const { createOpenAICompatibleProvider } = require('./openaiCompatible');
const { createGeminiProvider } = require('./gemini');
const { createMemoryRoutingStore } = require('./routingState');
const { wholeSentences } = require('./answerText');
const { createInferenceQueue } = require('./providerLimits');

const COMPLEX = ['analyse ', 'analysez', 'compare ', 'comparez', 'explique en détail', 'rédige ', 'démontre ', 'évalue ', 'résume ', 'développe ', 'fais une synthèse', 'stratégie', 'recommandation', 'comment améliorer', 'quelles sont les causes', "plan d'action", 'programme de', 'argumentes', 'quelles mesures', 'bilan', 'rapport complet', 'que penses-tu de', 'analyze ', 'analyse ', 'compare ', 'evaluate ', 'strategy', 'detailed report'];
const MEDIUM = ["qu'est-ce qu", 'comment', 'explique', 'définis', "c'est quoi", 'kesako', 'dis-moi', 'parle-moi', 'quelle est', 'quels sont', 'quelles sont', 'pourquoi', 'what is', 'how to', 'can you', 'tell me', 'explain'];
const SIMPLE = ['bonjour', 'salut', 'merci', 'ok', 'oui', 'non', 'ça va', 'hello', 'bonsoir', "d'accord", 'parfait', 'super', 'cool', 'ciao', 'bonne journée', 'thanks', 'bye', 'good morning', 'good evening'];

function estimateRequestComplexity(input) {
  const text = typeof input === 'string' ? input : (input?.messages || []).filter((m) => m.role === 'user').map((m) => m.text ?? m.content ?? '').join(' ');
  const lower = text.toLowerCase();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (COMPLEX.some((word) => lower.includes(word)) || words > 40) return 'complex';
  if (MEDIUM.some((word) => lower.includes(word))) return 'medium';
  if (words <= 10 || SIMPLE.some((word) => lower.includes(word))) return 'simple';
  return 'medium';
}

function estimateRequestTokens(request) {
  // Include instructions, history, tool schemas and the entire output budget.
  return Math.ceil(JSON.stringify(request).length / 3) + (request.maxTokens ?? 1200);
}

function freshState(now, state) {
  const day = new Date(now).toISOString().slice(0, 10);
  const next = { day, rpmWindow: [], rpdUsed: 0, tpdUsed: 0, cooldownUntil: 0, degradedUntil: 0, failures: 0, disabled: false, ...state };
  if (next.day !== day) Object.assign(next, { day, rpdUsed: 0, tpdUsed: 0 });
  if (next.degradedUntil > 0 && next.degradedUntil <= now) Object.assign(next, { degradedUntil: 0, failures: 0 });
  next.rpmWindow = next.rpmWindow.filter((time) => now - time < 60000);
  return next;
}
const aiError = (code) => Object.assign(new Error(code), { code });
const stopped = (signal) => { if (signal?.aborted) throw signal.reason; };
const keysOf = (value) => [...new Set((Array.isArray(value) ? value : [value]).filter((key) => typeof key === 'string' && key.trim()))];

function createConfiguredRouter(config = {}) {
  const definitions = config.providers || [];
  validateConfiguration(definitions, config);
  if (config.store && (typeof config.store.read !== 'function' || typeof config.store.update !== 'function')) throw new TypeError('INVALID_ROUTING_STORE');
  const store = config.store || createMemoryRoutingStore();
  const now = config.now || Date.now;
  const seen = new Set();
  const cursors = new Map();
  const queues = new Map(definitions.filter((provider) => provider.local).map((provider) => [provider.id, createInferenceQueue(provider)]));
  const prefix = config.statePrefix || 'routing:';
  const margins = { rpm: 0.75, rpd: 0.90, tpd: 0.85, ...(typeof config.quotaMargin === 'number' ? { rpm: config.quotaMargin, rpd: config.quotaMargin, tpd: config.quotaMargin } : config.quotaMargin) };
  const cooldownMs = config.cooldownMs ?? 120000;
  const degradedMs = config.degradedMs ?? 300000;
  const maxFailures = config.maxFailures ?? 3;
  const tokenBuffer = config.tokenBuffer ?? 1.2;
  let closed = false;

  async function change(key, update) {
    seen.add(key);
    try { return await store.update(prefix + key, update); }
    catch { throw aiError('AI_STATE_UNAVAILABLE'); }
  }
  async function reserve(key, model, cost, allowCooling) {
    return change(key, (state) => {
      const s = freshState(now(), state);
      const limited = s.disabled || s.degradedUntil > now() || (!allowCooling && s.cooldownUntil > now())
        || (model.rpm != null && s.rpmWindow.length + 1 > Math.floor(model.rpm * margins.rpm))
        || (model.rpd != null && s.rpdUsed + 1 > Math.floor(model.rpd * margins.rpd))
        || (model.tpd != null && s.tpdUsed + cost > Math.floor(model.tpd * margins.tpd));
      if (!limited) { s.rpmWindow.push(now()); s.rpdUsed += 1; s.tpdUsed += cost; }
      return { state: s, value: !limited };
    });
  }
  async function outcome(key, error) {
    await change(key, (state) => {
      const s = freshState(now(), state);
      const status = error?.statusCode ?? error?.status;
      if (!error) Object.assign(s, { failures: 0, degradedUntil: 0, cooldownUntil: 0 });
      else if (status === 404) s.disabled = true;
      else if (!['AI_LOCAL_QUEUE_FULL', 'AI_MODEL_RESERVED'].includes(error.code) && ![400, 413, 414, 422].includes(status)) {
        if (status === 429 || status === 503 || error.name === 'TimeoutError') s.cooldownUntil = now() + (error.retryAfterMs ?? (cooldownMs + Math.floor(Math.random() * (config.cooldownJitterMs ?? 0))));
        // A rate limit is not a broken model; repeated actual failures are.
        if (status !== 429) {
          s.failures += 1;
          if (s.failures >= maxFailures) s.degradedUntil = now() + degradedMs;
        }
      }
      return { state: s };
    });
  }

  async function route(input, options = {}, context = {}) {
    if (closed) throw aiError('AI_ROUTER_STOPPED');
    const request = typeof input === 'string' ? { messages: [{ role: 'user', text: input }] } : input;
    if (!request || !Array.isArray(request.messages)) throw new TypeError('AI_MESSAGES_REQUIRED');
    const ctx = { ...context, ...options.context, signal: options.signal || context.signal };
    stopped(ctx.signal);
    const complexity = options.complexity || estimateRequestComplexity(request);
    const images = request.messages.some((message) => message.images?.length || (Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')));
    const usage = options.usage || (request.tools?.length ? 'tools' : images ? 'vision' : options.json ? 'json' : complexity === 'simple' ? 'quick' : 'chat');
    const purpose = options.purpose || ctx.purpose || usage;
    ctx.purpose = purpose;
    ctx.timeoutMs = options.timeoutMs ?? (options.waitedOn === false ? config.backgroundTimeoutMs ?? 45000 : config.waitedTimeoutMs ?? 12000);
    const estimated = options.estimatedTokens ?? estimateRequestTokens(request);
    if (!Number.isFinite(estimated) || estimated < 0 || !Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) throw new TypeError('INVALID_ROUTING_REQUEST');
    const cost = Math.ceil(estimated * tokenBuffer);
    const byId = new Map(definitions.map((provider) => [provider.id, provider]));
    const pool = new Map();
    for (const definition of definitions) {
      const selected = definition.keysByUsage?.[purpose] || definition.keys;
      const source = typeof selected === 'function' ? await selected(ctx) : selected;
      pool.set(definition.id, keysOf(source));
    }
    let candidates = options.candidates || config.usages?.[usage] || (usage === 'tools' ? config.usages?.pilot : null)
      || definitions.flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, model: model.id })));
    candidates = candidates.map((entry) => {
      const provider = byId.get(entry.provider);
      const declared = provider?.models.find((model) => model.id === entry.model);
      return provider && declared ? { ...declared, ...entry, extra: { ...declared.extra, ...entry.extra } } : null;
    }).filter(Boolean);
    candidates = candidates.filter((model) => {
      const provider = byId.get(model.provider);
      return !model.disabled && !options.exclude?.includes(`${provider.id}:${model.model}`)
        && (!images || model.vision === true || (model.vision !== false && provider.vision === true))
        && (images || config.reserveVision !== true || model.visionOnly !== true)
        && (!model.languages || !options.language || model.languages.includes(options.language))
        && (!model.maxInputTokens || cost <= model.maxInputTokens)
        && (!model.noAnalytics || (!options.hasAnalytics && request.messages.length <= 3 && cost <= (model.maxInputTokens || 2000)));
    });
    const preferred = options.intent && config.intentRouting?.[options.intent]?.preferred || [];
    candidates = candidates.map((model, index) => ({ model, index })).sort((a, b) => {
      const rank = ({ model, index }) => {
        const intent = preferred.indexOf(`${model.provider}:${model.model}`) >= 0 ? preferred.indexOf(`${model.provider}:${model.model}`) : preferred.indexOf(model.model);
        if (intent >= 0) return intent;
        const fits = !model.complexity || model.complexity.includes(complexity);
        return preferred.length + (fits ? 0 : candidates.length) + (model.preview ? candidates.length * 2 : 0) + index;
      };
      return rank(a) - rank(b);
    }).map(({ model }) => model);
    const providers = [];
    const expanded = [];
    const metadata = new Map();
    for (const candidate of candidates) {
      const definition = byId.get(candidate.provider);
      const keys = pool.get(definition.id);
      const available = definition.local || keys.length;
      if (!available) continue;
      const slots = keys.length || 1;
      const cursorKey = `${definition.id}:${candidate.model}:${purpose}`;
      const start = (cursors.get(cursorKey) || 0) % slots;
      cursors.set(cursorKey, start + 1);
      for (let offset = 0; offset < slots; offset += 1) {
        const slot = (start + offset) % slots;
        const id = `configured_${providers.length}`;
        // Never put any part of a credential in a state key or result.
        const lane = definition.keysByUsage?.[purpose] ? purpose : typeof definition.keyLane === 'function' ? definition.keyLane(ctx) : '';
        const key = `${definition.id}:${candidate.model}@${lane ? lane + ':' : ''}key-${slot + 1}`;
        const stateKey = definition.sharedKeyQuotas ? `${definition.id}:${candidate.model}` : key;
        const adapterOptions = {
          id, models: [], fetch: config.fetch || globalThis.fetch, getKey: () => keys[slot] || 'local',
          toRequest: (value) => value, detailed: true, external: !definition.local,
          extra: definition.extra, endpoint: definition.url, url: definition.url
        };
        const adapter = definition.format === 'gemini' ? createGeminiProvider(adapterOptions) : createOpenAICompatibleProvider(adapterOptions);
        const call = adapter.call;
        const send = async (value, callCtx, model) => {
          stopped(callCtx.signal);
          if (!(await reserve(stateKey, candidate, cost, callCtx.allowCooling))) throw aiError('AI_MODEL_RESERVED');
          try {
            const answer = await call(value, callCtx, model);
            await outcome(stateKey, null);
            return answer;
          } catch (error) {
            stopped(Object.hasOwn(callCtx, 'callerSignal') ? callCtx.callerSignal : callCtx.signal);
            await outcome(stateKey, error);
            throw error;
          }
        };
        adapter.call = (value, callCtx, model) => {
          const queue = queues.get(definition.id);
          if (!queue) return send(value, callCtx, model);
          const queueSignal = globalThis.AbortSignal.any([callCtx.signal || new globalThis.AbortController().signal, globalThis.AbortSignal.timeout(callCtx.timeoutMs)]);
          return queue.run(() => send(value, { ...callCtx, signal: queueSignal, callerSignal: callCtx.signal }, model), { signal: queueSignal });
        };
        providers.push(adapter);
        expanded.push({ provider: id, model: candidate.model, extra: candidate.extra, maxTokens: candidate.maxTokens });
        metadata.set(id, { provider: definition.id, model: candidate.model, key, stateKey });
      }
    }
    if (!expanded.length) throw aiError(pool.size && [...pool.values()].some((keys) => keys.length) || definitions.some((p) => p.local) ? 'AI_NO_MATCH' : 'AI_NO_PROVIDER');
    let allCooling = true;
    for (const meta of metadata.values()) {
      let state;
      try { state = freshState(now(), await store.read(prefix + meta.stateKey)); }
      catch { throw aiError('AI_STATE_UNAVAILABLE'); }
      if (state.cooldownUntil <= now()) allCooling = false;
    }
    ctx.allowCooling = config.whenAllCooling === 'try' && allCooling;
    const router = createProviderRouter({ providers, cooldownOn: () => false, maxFailures: Infinity, now });
    const toolNames = new Set((request.tools || []).map((tool) => tool.name));
    const accepts = options.accepts || ((answer) => request.tools?.length && answer.toolCalls?.length
      ? answer.toolCalls.every((call) => call.id && toolNames.has(call.name) && (call.invalid || (call.args && typeof call.args === 'object' && !Array.isArray(call.args))))
      : Boolean(answer.text) && !answer.toolCalls?.length);
    try {
      const result = await router.route(request, { candidates: expanded, accepts, partial: (answer) => Boolean(answer.cut && answer.text && !answer.toolCalls?.length) }, ctx);
      const meta = metadata.get(result.provider);
      if (result.partial) result.value = { ...result.value, text: wholeSentences(result.value.text) };
      return { ...result, ...meta, usage, complexity, fallback: false };
    } catch (error) {
      stopped(ctx.signal);
      if (error.errors?.some((item) => item.code === 'AI_STATE_UNAVAILABLE')) throw aiError('AI_STATE_UNAVAILABLE');
      if (request.tools?.length && options.fallbackWithoutTools !== false) {
        const clean = { ...request, tools: [] };
        // Keep tool results in the transcript: they are already-read evidence.
        const fallback = await route(clean, { ...options, usage: images ? 'vision' : 'chat', fallbackWithoutTools: false, accepts: (answer) => Boolean(answer.text) && !answer.toolCalls?.length }, context);
        return { ...fallback, fallback: true };
      }
      // Transport messages may carry URLs, request bodies or credentials.
      throw aiError(error.code || 'AI_UNAVAILABLE');
    } finally { router.stop(); }
  }
  return {
    route,
    async ask(input, options, context) { return (await route(input, options, context)).value; },
    async getStats() {
      const stats = {};
      for (const key of seen) stats[key] = freshState(now(), await store.read(prefix + key));
      return stats;
    },
    async reset() { for (const key of seen) await change(key, () => ({ state: null })); },
    stop() { closed = true; },
    store
  };
}

function validateConfiguration(providers, config) {
  const ids = new Set();
  for (const provider of providers) {
    if (!provider.id || ids.has(provider.id)) throw new TypeError('INVALID_PROVIDER_ID');
    ids.add(provider.id);
    if (!['openai', 'gemini'].includes(provider.format)) throw new TypeError('INVALID_PROVIDER_FORMAT');
    if (!provider.url) throw new TypeError('PROVIDER_URL_REQUIRED');
    if (!Array.isArray(provider.models)) throw new TypeError('PROVIDER_MODELS_REQUIRED');
    const models = new Set();
    for (const model of provider.models) {
      if (!model.id || models.has(model.id)) throw new TypeError('INVALID_MODEL_ID');
      models.add(model.id);
      for (const quota of ['rpm', 'rpd', 'tpd']) if (model[quota] != null && (!Number.isFinite(model[quota]) || model[quota] < 0)) throw new TypeError('INVALID_MODEL_QUOTA');
    }
  }
  const margins = typeof config.quotaMargin === 'number' ? [config.quotaMargin] : Object.values(config.quotaMargin || {});
  if (margins.some((value) => !Number.isFinite(value) || value <= 0 || value > 1)) throw new TypeError('INVALID_QUOTA_MARGIN');
  if (config.whenAllCooling != null && !['skip', 'try'].includes(config.whenAllCooling)) throw new TypeError('INVALID_ROUTING_OPTION');
  for (const name of ['cooldownMs', 'degradedMs', 'cooldownJitterMs']) if (config[name] != null && (!Number.isFinite(config[name]) || config[name] < 0)) throw new TypeError('INVALID_ROUTING_OPTION');
  for (const name of ['waitedTimeoutMs', 'backgroundTimeoutMs', 'tokenBuffer', 'maxFailures']) if (config[name] != null && (!Number.isFinite(config[name]) || config[name] <= 0)) throw new TypeError('INVALID_ROUTING_OPTION');
}

module.exports = { createConfiguredRouter, estimateRequestComplexity, estimateRequestTokens };
