/**
 * L'API Gemini de Google (generateContent) : la même requête que le format
 * OpenAI (consigne, transcription, outils, photos), traduite dans la sienne,
 * et sa réponse lue de la même façon.
 *
 * Ce que l'usage a appris :
 *
 *   - Gemma ne prend pas de consigne système : elle passe en tête du premier
 *     message, les photos restant après ;
 *   - un modèle qui réfléchit rend sa réflexion en parties à elle (`thought`) :
 *     seule la réponse est gardée ;
 *   - une réponse arrêtée à sa longueur (MAX_TOKENS) le dit (`cut`), pour que le
 *     routeur la garde en dernier recours seulement ;
 *   - la clé part dans l'en-tête, jamais dans l'adresse (où elle finirait dans
 *     les journaux).
 */

const { providerResult, readWrittenAnswer, withoutThinking } = require('./modelAnswers');

const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 45_000;
const noSystemInstructionByDefault = (model) => String(model).startsWith('gemma-');

/* Des arguments illisibles (null) repartent en objet vide : Gemini refuse autre chose. */
const argsOf = (args) => (args && typeof args === 'object' && !Array.isArray(args) ? args : {});

function contentsOf(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message.role === 'assistant') {
      const parts = [];
      const text = message.text === undefined ? message.content : message.text;
      if (text) parts.push({ text });
      for (const call of message.toolCalls || []) parts.push({ functionCall: { name: call.name, args: argsOf(call.args) } });
      return { role: 'model', parts };
    }
    if (message.role === 'tool') {
      return { role: 'user', parts: [{ functionResponse: { name: message.name, response: { result: message.result } } }] };
    }
    /* Une photo jointe suit les mots, en ligne. */
    const text = message.text === undefined ? message.content || '' : message.text;
    return { role: 'user', parts: [{ text }, ...(message.images || []).map(({ mimeType, data }) => ({ inlineData: { mimeType, data } }))] };
  });
}

/** Le corps de la requête pour un modèle. */
function requestBody(model, request, noSystemInstruction) {
  const contents = contentsOf(request.messages);
  const generationConfig = {
    temperature: request.temperature === undefined ? 0.4 : request.temperature,
    maxOutputTokens: request.maxTokens || 1200
  };
  const functions = request.tools && request.tools.length ? { tools: [{ functionDeclarations: request.tools }] } : {};
  const system = request.system || '';
  if (!noSystemInstruction(model)) {
    return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, generationConfig, ...functions };
  }
  if (!system) return { contents, generationConfig, ...functions };
  const [first, ...rest] = contents;
  const firstParts = first ? first.parts : [];
  const head = firstParts[0] && typeof firstParts[0].text === 'string' ? firstParts[0].text : '';
  return {
    contents: [{ ...(first || { role: 'user' }), parts: [{ text: `${system}\n\n${head}` }, ...firstParts.slice(1)] }, ...rest],
    generationConfig,
    ...functions
  };
}

/**
 * Demande à un modèle Gemini.
 * @param {string} model
 * @param {{ system?: string, messages: object[], tools?: object[], maxTokens?: number, temperature?: number }} request
 * @param {{ key: string, fetch: Function, signal?: AbortSignal, timeoutMs?: number, endpoint?: string, noSystemInstruction?: Function }} io
 * @returns {Promise<{ status: number, text?: string|null, toolCalls?: object[], cut?: boolean }>}
 *   Un refus se résout en `{ status }` — rien n'est levé pour lui.
 */
async function askGeminiModel(model, request, io = {}) {
  if (typeof io.fetch !== 'function') throw new Error('askGeminiModel requires io.fetch.');
  const timeout = globalThis.AbortSignal.timeout(io.timeoutMs || DEFAULT_TIMEOUT_MS);
  const signal = io.signal ? globalThis.AbortSignal.any([io.signal, timeout]) : timeout;
  const response = await io.fetch(`${io.endpoint || DEFAULT_ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': io.key },
    body: JSON.stringify(requestBody(model, request, io.noSystemInstruction || noSystemInstructionByDefault)),
    signal
  });
  if (!response.ok) return { status: response.status };
  const answer = await response.json();
  const candidate = (answer && answer.candidates && answer.candidates[0]) || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const toolCalls = parts.filter((part) => part.functionCall).map((part, index) => ({
    id: part.functionCall.id || `call_${index}`,
    name: part.functionCall.name,
    args: argsOf(part.functionCall.args)
  }));
  if (toolCalls.length) return { status: response.status, text: null, toolCalls };
  const text = withoutThinking(parts.filter((part) => !part.thought).map((part) => part.text || '').join(''));
  const written = readWrittenAnswer(text, Boolean(request.tools && request.tools.length));
  if (written) return { status: response.status, ...written };
  return { status: response.status, text, cut: candidate.finishReason === 'MAX_TOKENS' };
}

/**
 * Un fournisseur Gemini pour createProviderRouter : mêmes options que
 * createOpenAICompatibleProvider, sans adresse (le point d'accès de Google,
 * ou `endpoint`).
 *
 * @param {object} options
 * @param {string} [options.id='gemini']
 * @param {Function} options.getKey  (ctx) => clé, relue à chaque appel.
 * @param {object[]} options.models
 * @param {Function} options.fetch   `ctx.fetch` le remplace pour un appel.
 * @param {Function} [options.lane]  (ctx) => voie | null : une clé à elle pour cet usage.
 * @param {boolean} [options.detailed]
 * @param {number} [options.timeoutMs] `ctx.timeoutMs` le remplace pour un appel.
 * @param {string} [options.endpoint]
 * @param {Function} [options.noSystemInstruction] (modelId) => true pour un modèle sans consigne système. Défaut : Gemma.
 * @param {Function} [options.toRequest] (prompt, ctx) => { system?, messages, tools?, maxTokens? }.
 */
function createGeminiProvider(options = {}) {
  if (typeof options.getKey !== 'function') throw new Error('createGeminiProvider requires options.getKey.');
  if (typeof options.fetch !== 'function') throw new Error('createGeminiProvider requires options.fetch.');
  const id = options.id || 'gemini';
  const toRequest = options.toRequest || ((prompt) => ({ messages: [{ role: 'user', text: String(prompt) }] }));

  return {
    id,
    models: options.models || [],
    ...(typeof options.lane === 'function' ? { lane: options.lane } : {}),
    async available(ctx = {}) {
      return Boolean(await options.getKey(ctx));
    },
    async call(prompt, ctx = {}, model = {}) {
      const key = await options.getKey(ctx);
      if (!key) {
        const missing = new Error(`Provider "${id}" has no key.`);
        missing.statusCode = 401;
        throw missing;
      }
      const answer = await askGeminiModel(model.id, { maxTokens: model.maxTokens, ...toRequest(prompt, ctx) }, {
        key,
        fetch: typeof ctx.fetch === 'function' ? ctx.fetch : options.fetch,
        signal: ctx.signal,
        timeoutMs: ctx.timeoutMs || options.timeoutMs,
        endpoint: options.endpoint,
        noSystemInstruction: options.noSystemInstruction
      });
      return providerResult(id, answer, options.detailed);
    }
  };
}

module.exports = { askGeminiModel, createGeminiProvider };
