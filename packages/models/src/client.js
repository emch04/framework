/* global AbortController */

/**
 * Client of the local CPU model service (server/app.py).
 *
 * Everything the service does is OPTIONAL for its callers: a reranker that is
 * down means results in their original order, a missing embedding means a
 * keyword search. So no method ever throws — each resolves to
 *   { ok: true, ...data }  or  { ok: false, code, endpoint, retryable, status?, message? }
 * and the caller keeps its previous behaviour on `ok: false`.
 *
 * Per endpoint: a timeout, a retry budget with full jitter, and a circuit
 * breaker — a service that is down costs one fast refusal, not a timeout per
 * request. One breaker PER endpoint: a slow reranker must not switch off
 * entity masking. Only outages count against a breaker; a request the server
 * refuses as invalid is an answer, not an outage.
 */

const { createEndpointBreaker } = require('./breaker');

const ENDPOINTS = Object.freeze(['embed', 'rerank', 'nli', 'entities', 'transcribe']);

const DEFAULT_TIMEOUTS = Object.freeze({
  embed: 1500, rerank: 1000, nli: 1500, entities: 800, transcribe: 15000, health: 1000
});

/* Transcription is heavy and not worth repeating inside a live exchange. */
const DEFAULT_ATTEMPTS = Object.freeze({
  embed: 2, rerank: 2, nli: 2, entities: 2, transcribe: 1, health: 1
});

/* Mirrors the server defaults; change both together. */
const DEFAULT_LIMITS = Object.freeze({
  embedMaxBatch: 32,
  embedMaxChars: 2000,
  rerankMaxDocuments: 50,
  rerankMaxChars: 2000,
  nliMaxPairs: 20,
  nliMaxChars: 2000,
  entitiesMaxChars: 8000,
  entitiesMaxLabels: 10,
  entitiesMaxLabelChars: 50,
  transcribeMinSeconds: 0.2,
  transcribeMaxSeconds: 30,
  transcribeMaxPromptChars: 600
});

const SAMPLE_RATE = 16000;
const LANGUAGE = /^[a-z]{2,3}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/* Outages: they count against the breaker. Anything else is an answer. */
const FAILURE_CODES = new Set([
  'timeout', 'network_error', 'server_error', 'unavailable', 'model_unavailable', 'model_not_configured',
  'busy', 'memory_limit', 'bad_response', 'unauthorized', 'not_found'
]);
const RETRYABLE_CODES = new Set(['network_error', 'server_error', 'busy', 'unavailable']);
const SERVICE_503_CODES = new Set(['model_unavailable', 'model_not_configured', 'busy', 'memory_limit']);

const RESULT_CODES = Object.freeze([
  'invalid_input', 'payload_too_large', 'unauthorized', 'not_found', 'model_not_configured',
  'model_unavailable', 'busy', 'memory_limit', 'unavailable', 'server_error', 'timeout',
  'network_error', 'bad_response', 'circuit_open', 'model_mismatch', 'aborted'
]);

class CallFailure extends Error {
  constructor(result) {
    super(result.code);
    this.result = result;
  }
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isOffset = (value) => Number.isInteger(value) && value >= 0;

function base64ByteLength(text) {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

function normaliseBaseUrl(value) {
  const raw = value || 'http://127.0.0.1:5007';
  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw new TypeError('createModelsClient: baseUrl must be an absolute http(s) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('createModelsClient: baseUrl must be an absolute http(s) URL.');
  }
  return raw.replace(/\/+$/, '');
}

function createModelsClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('createModelsClient: a fetch function is required.');
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const tokenOption = options.token;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) };
  const retryOptions = options.retry || {};
  const attemptsFor = (endpoint) => {
    const value = retryOptions.attempts;
    if (typeof value === 'number') return Math.max(1, Math.floor(value));
    if (value && typeof value[endpoint] === 'number') return Math.max(1, Math.floor(value[endpoint]));
    return DEFAULT_ATTEMPTS[endpoint];
  };
  const baseDelayMs = retryOptions.baseDelayMs === undefined ? 100 : retryOptions.baseDelayMs;
  const maxDelayMs = retryOptions.maxDelayMs === undefined ? 1000 : retryOptions.maxDelayMs;
  const retryTimeouts = Boolean(retryOptions.retryTimeouts);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const embedModel = options.embedModel || null;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random || Math.random;
  const onEvent = options.onEvent || (() => {});
  const breakerOption = options.breaker === undefined ? {} : options.breaker;
  const createBreaker = options.createBreaker || (breakerOption === false ? null
    : (endpoint) => createEndpointBreaker({
      name: `models:${endpoint}`,
      failureThreshold: breakerOption.failureThreshold || 3,
      recoveryMs: breakerOption.recoveryMs === undefined ? 60_000 : breakerOption.recoveryMs,
      now,
      onStateChange: ({ from, to }) => emit({ type: 'breaker', endpoint, from, to })
    }));
  const breakers = new Map();

  function emit(event) {
    try { onEvent(event); } catch (_error) { /* observers never break a call */ }
  }

  function breakerFor(endpoint) {
    if (!createBreaker) return null;
    if (!breakers.has(endpoint)) breakers.set(endpoint, createBreaker(endpoint));
    return breakers.get(endpoint);
  }

  function refuse(endpoint, code, extra = {}) {
    return { ok: false, code, endpoint, retryable: RETRYABLE_CODES.has(code), ...extra };
  }

  async function headers() {
    const result = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const token = typeof tokenOption === 'function' ? await tokenOption() : tokenOption;
    if (token) result.Authorization = `Bearer ${token}`;
    return result;
  }

  function statusResult(endpoint, status, body) {
    const serverCode = body && body.error && typeof body.error.code === 'string' ? body.error.code : null;
    const message = body && body.error && typeof body.error.message === 'string' ? body.error.message : undefined;
    const extra = { status };
    if (message) extra.message = message;
    if (status === 400) return refuse(endpoint, 'invalid_input', extra);
    if (status === 401 || status === 403) return refuse(endpoint, 'unauthorized', extra);
    if (status === 404 || status === 405) return refuse(endpoint, 'not_found', extra);
    if (status === 411 || status === 413) return refuse(endpoint, 'payload_too_large', extra);
    if (status === 503) return refuse(endpoint, SERVICE_503_CODES.has(serverCode) ? serverCode : 'unavailable', extra);
    return refuse(endpoint, 'server_error', extra);
  }

  /* One HTTP exchange, bounded by `timeoutMs` from the request to the end of the body. */
  async function exchange(endpoint, method, path, body, timeoutMs, signal) {
    if (signal && signal.aborted) return refuse(endpoint, 'aborted');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: await headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
      } catch (_error) {
        if (timedOut) return refuse(endpoint, 'timeout');
        if (signal && signal.aborted) return refuse(endpoint, 'aborted');
        return refuse(endpoint, 'network_error');
      }
      let data = null;
      let parsed = true;
      try {
        data = await response.json();
      } catch (_error) {
        if (timedOut) return refuse(endpoint, 'timeout');
        if (signal && signal.aborted) return refuse(endpoint, 'aborted');
        parsed = false;
      }
      if (response.status < 200 || response.status >= 300) return statusResult(endpoint, response.status, data);
      if (!parsed) return refuse(endpoint, 'bad_response', { status: response.status });
      return { ok: true, data };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function attempts(endpoint, method, path, body, callOptions, read) {
    const total = callOptions.attempts ? Math.max(1, Math.floor(callOptions.attempts)) : attemptsFor(endpoint);
    const timeoutMs = callOptions.timeoutMs || timeouts[endpoint];
    let result;
    for (let attempt = 1; attempt <= total; attempt += 1) {
      const raw = await exchange(endpoint, method, path, body, timeoutMs, callOptions.signal);
      if (raw.ok) {
        const value = read(raw.data);
        result = value ? { ok: true, ...value } : refuse(endpoint, 'bad_response', { status: 200 });
      } else {
        result = raw;
      }
      const retryable = !result.ok && (RETRYABLE_CODES.has(result.code) || (retryTimeouts && result.code === 'timeout'));
      if (result.ok || !retryable || attempt === total) break;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.round(random() * ceiling);
      emit({ type: 'retry', endpoint, code: result.code, attempt, delayMs });
      await sleep(delayMs);
    }
    return result;
  }

  /* Retries run INSIDE one breaker call: a request that needed two tries is one success or one failure. */
  async function call(endpoint, method, path, body, callOptions, read) {
    const breaker = breakerFor(endpoint);
    const run = async () => {
      const result = await attempts(endpoint, method, path, body, callOptions, read);
      if (!result.ok && FAILURE_CODES.has(result.code)) throw new CallFailure(result);
      return result;
    };
    let result;
    try {
      result = breaker ? await breaker.call(run) : await run();
    } catch (error) {
      if (error instanceof CallFailure) {
        result = error.result;
      } else if (error && error.code === 'CIRCUIT_OPEN') {
        emit({ type: 'circuit_open', endpoint });
        return refuse(endpoint, 'circuit_open', typeof error.retryInMs === 'number' ? { retryInMs: error.retryInMs } : {});
      } else {
        result = refuse(endpoint, 'unavailable');
      }
    }
    if (!result.ok) emit({ type: 'failure', endpoint, code: result.code, status: result.status });
    return result;
  }

  /* ---- endpoints ------------------------------------------------------- */

  function embed(texts, callOptions = {}) {
    if (!Array.isArray(texts) || !texts.length || texts.length > limits.embedMaxBatch
      || !texts.every((t) => isText(t) && t.length <= limits.embedMaxChars)) {
      return Promise.resolve(refuse('embed', 'invalid_input'));
    }
    return call('embed', 'POST', '/embed', { texts }, callOptions, (data) => {
      const vectors = data && data.vectors;
      if (!Array.isArray(vectors) || vectors.length !== texts.length || !isText(data.model)) return null;
      const dimensions = Array.isArray(vectors[0]) ? vectors[0].length : 0;
      const valid = (v) => Array.isArray(v) && v.length === dimensions && v.every(isNumber);
      if (!dimensions || !vectors.every(valid)) return null;
      if (data.dimensions !== undefined && data.dimensions !== dimensions) return null;
      return { vectors, model: data.model, dimensions };
    }).then((result) => {
      /* Vectors of two models live in two spaces: comparing them is silently meaningless. */
      if (result.ok && embedModel && result.model !== embedModel) {
        return refuse('embed', 'model_mismatch', { model: result.model, expected: embedModel });
      }
      return result;
    });
  }

  function rerank(query, documents, callOptions = {}) {
    if (!isText(query) || !Array.isArray(documents) || !documents.length
      || documents.length > limits.rerankMaxDocuments || !documents.every((d) => typeof d === 'string')) {
      return Promise.resolve(refuse('rerank', 'invalid_input'));
    }
    /* The server keeps only the head of each text: sending the rest is wasted bandwidth. */
    const cut = (text) => text.slice(0, limits.rerankMaxChars);
    return call('rerank', 'POST', '/rerank', { query: cut(query), documents: documents.map(cut) }, callOptions, (data) => {
      const scores = data && data.scores;
      if (!Array.isArray(scores) || scores.length !== documents.length || !scores.every(isNumber)) return null;
      return { scores, model: typeof data.model === 'string' ? data.model : null };
    });
  }

  function nli(pairs, callOptions = {}) {
    if (!Array.isArray(pairs) || !pairs.length || pairs.length > limits.nliMaxPairs
      || !pairs.every((p) => p && isText(p.premise) && isText(p.hypothesis))) {
      return Promise.resolve(refuse('nli', 'invalid_input'));
    }
    const cut = (text) => text.slice(0, limits.nliMaxChars);
    const body = { pairs: pairs.map((p) => ({ premise: cut(p.premise), hypothesis: cut(p.hypothesis) })) };
    return call('nli', 'POST', '/nli', body, callOptions, (data) => {
      const results = data && data.results;
      const valid = (r) => r && isNumber(r.entailment) && isNumber(r.neutral) && isNumber(r.contradiction);
      if (!Array.isArray(results) || results.length !== pairs.length || !results.every(valid)) return null;
      return {
        results: results.map((r) => ({ entailment: r.entailment, neutral: r.neutral, contradiction: r.contradiction })),
        model: typeof data.model === 'string' ? data.model : null
      };
    });
  }

  function entities(text, labels, callOptions = {}) {
    if (labels !== undefined && labels !== null && !Array.isArray(labels)) {
      callOptions = labels;
      labels = undefined;
    }
    if (!isText(text) || text.length > limits.entitiesMaxChars) return Promise.resolve(refuse('entities', 'invalid_input'));
    if (labels !== undefined && labels !== null && (!labels.length || labels.length > limits.entitiesMaxLabels
      || !labels.every((l) => isText(l) && l.length <= limits.entitiesMaxLabelChars))) {
      return Promise.resolve(refuse('entities', 'invalid_input'));
    }
    const body = labels ? { text, labels } : { text };
    return call('entities', 'POST', '/entities', body, callOptions || {}, (data) => {
      const list = data && data.entities;
      const valid = (e) => e && typeof e.text === 'string' && typeof e.label === 'string'
        && isOffset(e.start) && isOffset(e.end) && e.start <= e.end && e.end <= text.length && isNumber(e.score);
      if (!Array.isArray(list) || !list.every(valid)) return null;
      return {
        entities: list.map((e) => ({ text: e.text, label: e.label, start: e.start, end: e.end, score: e.score })),
        model: typeof data.model === 'string' ? data.model : null
      };
    });
  }

  function transcribe(audio, callOptions = {}) {
    const { language = null, prompt = '', vad } = callOptions;
    let encoded = null;
    if (typeof audio === 'string' && audio && audio.length % 4 === 0 && BASE64.test(audio)) {
      encoded = audio;
    } else if (audio instanceof Uint8Array) {
      encoded = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64');
    }
    const bytes = encoded ? base64ByteLength(encoded) : 0;
    const minBytes = Math.floor(limits.transcribeMinSeconds * SAMPLE_RATE) * 2;
    const maxBytes = Math.floor(limits.transcribeMaxSeconds * SAMPLE_RATE) * 2;
    const languageOk = language === null || language === undefined || language === 'auto'
      || (typeof language === 'string' && LANGUAGE.test(language));
    if (!encoded || bytes % 2 || bytes < minBytes || bytes > maxBytes || !languageOk
      || typeof prompt !== 'string' || prompt.length > limits.transcribeMaxPromptChars
      || (vad !== undefined && typeof vad !== 'boolean')) {
      return Promise.resolve(refuse('transcribe', 'invalid_input'));
    }
    const body = { audio: encoded, language: language === undefined ? null : language, prompt };
    if (vad !== undefined) body.vad = vad;
    return call('transcribe', 'POST', '/transcribe', body, callOptions, (data) => {
      if (!data || typeof data.text !== 'string' || typeof data.language !== 'string'
        || !isNumber(data.avg_logprob) || !isNumber(data.no_speech_prob) || !isNumber(data.duration_ms)) return null;
      /* An empty text is an answer (silence), not an outage. */
      return {
        text: data.text,
        language: data.language,
        avgLogprob: data.avg_logprob,
        noSpeechProb: data.no_speech_prob,
        durationMs: data.duration_ms,
        audioMs: isNumber(data.audio_ms) ? data.audio_ms : Math.round((bytes / 2 / SAMPLE_RATE) * 1000),
        model: typeof data.model === 'string' ? data.model : null
      };
    });
  }

  /* Health never goes through a breaker: it is how an operator checks a service the breaker gave up on. */
  async function health(callOptions = {}) {
    const result = await attempts('health', 'GET', '/health', undefined, callOptions, (data) => {
      if (!data || data.status !== 'ok' || !data.models || typeof data.models !== 'object') return null;
      return { version: typeof data.version === 'string' ? data.version : null, models: data.models };
    });
    return result;
  }

  function available(endpoint) {
    const breaker = breakerFor(endpoint);
    if (!breaker || typeof breaker.isOpen !== 'function') return true;
    return !breaker.isOpen();
  }

  function breakerStatus(endpoint) {
    const breaker = breakerFor(endpoint);
    return breaker && typeof breaker.status === 'function' ? breaker.status() : null;
  }

  function resetBreakers() {
    for (const breaker of breakers.values()) if (typeof breaker.reset === 'function') breaker.reset();
  }

  /**
   * An `embed` function for @astratra/memory: one text in, `{ vector, source }`
   * out, where `source` is the model id — so vectors of two models are never
   * compared. Throws on failure: memory keeps the record and reindexes later.
   */
  function asMemoryEmbed(adapterOptions = {}) {
    return async (text) => {
      const result = await embed([text], adapterOptions);
      if (!result.ok) {
        const error = new Error(`Embedding unavailable (${result.code}).`);
        error.code = result.code;
        throw error;
      }
      return { vector: result.vectors[0], source: result.model };
    };
  }

  return {
    embed, rerank, nli, entities, transcribe, health,
    available, breakerStatus, resetBreakers, asMemoryEmbed
  };
}

module.exports = {
  createModelsClient,
  ENDPOINTS,
  DEFAULT_TIMEOUTS,
  DEFAULT_ATTEMPTS,
  DEFAULT_LIMITS,
  RESULT_CODES
};
