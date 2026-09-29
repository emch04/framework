/**
 * Providers that speak the OpenAI chat format (Groq, Mistral, Cloudflare
 * Workers AI, gateways…): one request shape, one way to read the answer.
 *
 * Three things real traffic taught:
 *
 *   - a model sometimes returns tool arguments that are not JSON. Parsing them
 *     blindly threw inside the turn and lost the whole answer; a malformed call
 *     is now reported as such and the loop decides;
 *   - reasoning models write their thinking between think tags inside the
 *     answer — never shown, even when the closing tag is missing;
 *   - an error carries the HTTP status (a 429 must reach the router's cooldown)
 *     and never the key.
 */

const { providerResult, readToolArguments, readWrittenAnswer, readWrittenToolCalls, toolCallOf, withoutThinking } = require('./modelAnswers');

function toTranscript(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.text === undefined ? message.content || '' : message.text,
        ...(message.toolCalls && message.toolCalls.length ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            /* Des arguments illisibles (null) repartent en objet vide : le fournisseur refuserait « null ». */
            function: { name: call.name, arguments: JSON.stringify(call.args && typeof call.args === 'object' ? call.args : {}) }
          }))
        } : {})
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: typeof message.result === 'string' ? message.result : JSON.stringify(message.result) };
    }
    const text = message.text === undefined ? message.content || '' : message.text;
    /* A photo joined by the person: an image part with a data address. Only
       send it to models that see. */
    if (message.images && message.images.length) {
      return {
        role: 'user',
        content: [
          { type: 'text', text },
          ...message.images.map(({ mimeType, data }) => ({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }))
        ]
      };
    }
    return { role: message.role === 'system' ? 'system' : 'user', content: text };
  });
}

/**
 * Ask one model.
 * @param {{ url: string, key: string, model: string, extra?: object }} target
 * @param {{ system?: string, messages: object[], tools?: object[], maxTokens?: number, temperature?: number }} request
 * @param {{ fetch: Function, signal?: AbortSignal, timeoutMs?: number }} io
 * @returns {Promise<{ status: number, text?: string|null, toolCalls?: object[], cut?: boolean }>}
 *   A non-2xx answer resolves `{ status }` — nothing is thrown for it.
 */
async function askChatModel(target, request, io = {}) {
  if (typeof io.fetch !== 'function') throw new Error('askChatModel requires io.fetch.');
  const { url, key, model, extra = {} } = target || {};
  const timeoutMs = io.timeoutMs || 45_000;
  const Signal = globalThis.AbortSignal;
  const timeout = Signal.timeout(timeoutMs);
  const signal = io.signal && typeof Signal.any === 'function' ? Signal.any([io.signal, timeout]) : (io.signal || timeout);
  const messages = [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ...toTranscript(request.messages)
  ];
  const response = await io.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: request.temperature === undefined ? 0.4 : request.temperature,
      max_tokens: request.maxTokens || 1200,
      ...(request.tools && request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
      ...extra
    }),
    signal
  });
  if (!response.ok) return { status: response.status };
  const answer = await response.json();
  const choice = (answer && answer.choices && answer.choices[0]) || {};
  const message = choice.message || {};
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return {
      status: response.status,
      text: null,
      toolCalls: message.tool_calls.map((call) => toolCallOf(call.id, call.function && call.function.name, call.function && call.function.arguments))
    };
  }
  const text = withoutThinking(message.content);
  const written = readWrittenAnswer(text, Boolean(request.tools && request.tools.length));
  if (written) return { status: response.status, ...written };
  return { status: response.status, text, cut: choice.finish_reason === 'length' };
}

/**
 * A provider for createProviderRouter, over an OpenAI-compatible endpoint.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {string|Function} options.url  or (ctx) => url, read at every call (an account id kept with the keys).
 * @param {Function} options.getKey  (ctx) => key, read at every call: a key changed
 *   from the settings screen takes effect without a restart.
 * @param {object[]} options.models  router model entries ({ id, rpm, rpd, tpd, complexity, extra? }).
 *   A model's `extra` joins the provider's for that model only.
 * @param {Function} options.fetch   `ctx.fetch`, when given, replaces it for one call.
 * @param {boolean} [options.external] false for a model on this machine: the router then does not mask.
 * @param {number} [options.timeoutMs] `ctx.timeoutMs` replaces it for one call.
 * @param {object} [options.extra]   joined to each request.
 * @param {Function} [options.lane]  (ctx) => string | null — a key of its own for this use: the router rests it apart.
 * @param {boolean} [options.detailed] true: the call resolves { text, toolCalls, cut } (an empty text
 *   included, for the router's `accepts` to judge) instead of the text alone.
 * @param {Function} [options.toRequest] (prompt, ctx) => { system?, messages, tools?, maxTokens? }. Default: the prompt as one user message.
 */
function createOpenAICompatibleProvider(options = {}) {
  if (typeof options.id !== 'string' || !options.id) throw new Error('createOpenAICompatibleProvider requires options.id.');
  if (!(typeof options.url === 'function' || (typeof options.url === 'string' && options.url))) {
    throw new Error('createOpenAICompatibleProvider requires options.url.');
  }
  if (typeof options.getKey !== 'function') throw new Error('createOpenAICompatibleProvider requires options.getKey.');
  if (typeof options.fetch !== 'function') throw new Error('createOpenAICompatibleProvider requires options.fetch.');
  const toRequest = options.toRequest || ((prompt) => ({ messages: [{ role: 'user', text: String(prompt) }] }));
  const urlOf = (ctx) => (typeof options.url === 'function' ? options.url(ctx) : options.url);

  return {
    id: options.id,
    models: options.models || [],
    ...(options.external === false ? { external: false } : {}),
    ...(typeof options.lane === 'function' ? { lane: options.lane } : {}),
    /* Sans clé (ou sans adresse), le routeur saute ce fournisseur sans rien lui demander. */
    async available(ctx = {}) {
      return Boolean(urlOf(ctx)) && Boolean(await options.getKey(ctx));
    },
    async call(prompt, ctx = {}, model = {}) {
      const key = await options.getKey(ctx);
      const url = urlOf(ctx);
      if (!key || !url) {
        const missing = new Error(`Provider "${options.id}" has no key.`);
        missing.statusCode = 401;
        throw missing;
      }
      const answer = await askChatModel(
        { url, key, model: model.id, extra: { ...(options.extra || {}), ...(model.extra || {}) } },
        { maxTokens: model.maxTokens, ...toRequest(prompt, ctx) },
        { fetch: typeof ctx.fetch === 'function' ? ctx.fetch : options.fetch, signal: ctx.signal, timeoutMs: ctx.timeoutMs || options.timeoutMs }
      );
      return providerResult(options.id, answer, options.detailed);
    }
  };
}

module.exports = { askChatModel, createOpenAICompatibleProvider, readToolArguments, readWrittenToolCalls, withoutThinking };
