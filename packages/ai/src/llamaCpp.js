'use strict';

/* global AbortController, TextDecoder */

/*
 * Fournisseur d'un `llama-server` (llama.cpp), inférence sur CPU, API compatible
 * OpenAI. Ce n'est pas un doublon de openaiCompatible.js : celui-ci branche un
 * modèle dans le routeur et avale les erreurs HTTP (il rend `{ status }`), alors
 * qu'un serveur qu'on héberge soi-même a besoin de sa santé (/health), du
 * chargement du modèle (503), de la liste de ses modèles et d'erreurs typées.
 * Pour router ce serveur, `toOpenAICompatible()` donne l'adresse et la clé à
 * `createOpenAICompatibleProvider`.
 */

const DEFAULT_LLAMA_CPP_URL = 'http://127.0.0.1:8080';

/**
 * `llama-server` expose l'API OpenAI sous /v1 et sa santé sous /health (hors
 * /v1). On garde donc une base nue et on ajoute les chemins nous-mêmes : que
 * l'utilisateur écrive `http://hote:8080` ou `http://hote:8080/v1`, c'est pareil.
 */
function normalizeLlamaCppUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('INVALID_BASE_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('INVALID_BASE_URL');
  return url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function createLlamaCppConfig({ baseUrl = DEFAULT_LLAMA_CPP_URL, apiKey = null, model = null, timeoutMs = 120_000, healthTimeoutMs = 5_000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('INVALID_TIMEOUT');
  if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs <= 0) throw new RangeError('INVALID_TIMEOUT');
  return Object.freeze({
    id: 'llama.cpp',
    baseUrl: normalizeLlamaCppUrl(baseUrl),
    apiKey: apiKey || null,
    model: model || null,
    timeoutMs,
    healthTimeoutMs
  });
}


/** Erreur du fournisseur local ; `code` : UNREACHABLE, TIMEOUT, UNAUTHORIZED, LOADING, HTTP_ERROR, INVALID_RESPONSE. */
class LocalLlmError extends Error {
  constructor(code, message, { status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LocalLlmError';
    this.code = code;
    this.status = status;
  }
}


const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Client d'un `llama-server` (llama.cpp) : API compatible OpenAI, inférence sur
 * CPU. Aucune dépendance : `fetch` est injectable pour les tests.
 */
function createLlamaCppProvider(options = {}) {
  const config = createLlamaCppConfig(options);
  const fetchImpl = options.fetch || globalThis.fetch;
  const sleep = options.sleep || wait;
  if (typeof fetchImpl !== 'function') throw new TypeError('FETCH_REQUIRED');

  function headers(extra) {
    return { ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), ...extra };
  }

  async function request(path, { method = 'GET', body, timeoutMs = config.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${config.baseUrl}${path}`, {
        method,
        headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new LocalLlmError('TIMEOUT', `Pas de réponse en ${timeoutMs} ms`, { cause: error });
      throw new LocalLlmError('UNREACHABLE', `Serveur injoignable (${config.baseUrl})`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async function failure(response) {
    let detail = '';
    try { detail = (await response.json())?.error?.message || ''; } catch { /* corps non JSON */ }
    if (response.status === 401 || response.status === 403) return new LocalLlmError('UNAUTHORIZED', 'Clé API refusée', { status: response.status });
    if (response.status === 503) return new LocalLlmError('LOADING', detail || 'Modèle en cours de chargement', { status: 503 });
    return new LocalLlmError('HTTP_ERROR', detail || `Réponse HTTP ${response.status}`, { status: response.status });
  }

  async function json(response) {
    try {
      return await response.json();
    } catch (error) {
      throw new LocalLlmError('INVALID_RESPONSE', 'Réponse non JSON', { cause: error });
    }
  }

  /** `{ ok, status }` — status : ok | loading | unauthorized | error | unreachable | timeout. Ne lance jamais. */
  async function health() {
    const started = Date.now();
    try {
      const response = await request('/health', { timeoutMs: config.healthTimeoutMs });
      const latencyMs = Date.now() - started;
      if (response.ok) return { ok: true, status: 'ok', latencyMs };
      const error = await failure(response);
      return { ok: false, status: error.code === 'LOADING' ? 'loading' : error.code === 'UNAUTHORIZED' ? 'unauthorized' : 'error', httpStatus: response.status, latencyMs, message: error.message };
    } catch (error) {
      return { ok: false, status: error.code === 'TIMEOUT' ? 'timeout' : 'unreachable', latencyMs: Date.now() - started, message: error.message };
    }
  }

  /** Attend que le modèle soit chargé (le premier démarrage peut prendre une minute). */
  async function waitUntilReady({ timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await health();
      if (state.ok) return state;
      if (state.status === 'unauthorized') throw new LocalLlmError('UNAUTHORIZED', state.message, { status: state.httpStatus });
      if (Date.now() + intervalMs > deadline) throw new LocalLlmError('TIMEOUT', `Serveur pas prêt après ${timeoutMs} ms (${state.status})`);
      await sleep(intervalMs);
    }
  }

  /** Modèles servis, au format OpenAI : `[{ id, ownedBy }]`. */
  async function listModels() {
    const response = await request('/v1/models');
    if (!response.ok) throw await failure(response);
    const payload = await json(response);
    if (!Array.isArray(payload?.data)) throw new LocalLlmError('INVALID_RESPONSE', 'Liste de modèles absente');
    return payload.data.map((item) => ({ id: item.id, ownedBy: item.owned_by ?? null }));
  }

  function chatBody(messages, { model, stream = false, ...rest } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('MESSAGES_REQUIRED');
    // llama-server ne sert qu'un modèle : le champ « model » est facultatif chez lui, on le passe s'il est connu.
    const name = model || config.model;
    return { ...(name ? { model: name } : {}), messages, stream, ...rest };
  }

  async function chat(messages, options = {}) {
    const response = await request('/v1/chat/completions', { method: 'POST', body: chatBody(messages, { ...options, stream: false }) });
    if (!response.ok) throw await failure(response);
    const payload = await json(response);
    const choice = payload?.choices?.[0];
    if (!choice?.message) throw new LocalLlmError('INVALID_RESPONSE', 'Réponse sans choix');
    return { text: choice.message.content ?? '', finishReason: choice.finish_reason ?? null, usage: payload.usage ?? null, model: payload.model ?? null };
  }

  /** Itère sur les fragments de texte (SSE `data: {...}` jusqu'à `[DONE]`). */
  async function* chatStream(messages, options = {}) {
    const response = await request('/v1/chat/completions', { method: 'POST', body: chatBody(messages, { ...options, stream: true }) });
    if (!response.ok) throw await failure(response);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let parsed;
        try { parsed = JSON.parse(data); } catch (error) { throw new LocalLlmError('INVALID_RESPONSE', 'Fragment SSE illisible', { cause: error }); }
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  }

  /** Configuration à donner à tout client « compatible OpenAI » (SDK, LiteLLM, autre paquet). */
  function toOpenAICompatible() {
    return { baseURL: `${config.baseUrl}/v1`, apiKey: config.apiKey || 'sans-cle', model: config.model };
  }

  return { config, health, waitUntilReady, listModels, chat, chatStream, toOpenAICompatible };
}


module.exports = {
  DEFAULT_LLAMA_CPP_URL, normalizeLlamaCppUrl, createLlamaCppConfig, createLlamaCppProvider, LocalLlmError
};
