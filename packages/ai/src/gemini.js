const { readRetryAfter } = require('./providerLimits');
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
 *     les journaux) ;
 *   - la recherche Google intégrée (`googleSearch` sur la requête) rend ses
 *     sources sous une forme stable (`grounding`) ; les pages lues sont des
 *     DONNÉES NON FIABLES : rien ici ne les relit comme des consignes, seuls
 *     des titres et des adresses http(s) nettoyés sont rendus.
 */

const { providerResult, readWrittenAnswer, withoutThinking } = require('./modelAnswers');
const { readServerEvents, textReporter } = require('./streamedAnswer');

const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 45_000;
const noSystemInstructionByDefault = (model) => String(model).startsWith('gemma-');

/* Des arguments illisibles (null) repartent en objet vide : Gemini refuse autre chose. */
const argsOf = (args) => (args && typeof args === 'object' && !Array.isArray(args) ? args : {});

/* Gemini 3 vérifie la signature de pensée du premier appel de chaque étape (les appels parallèles suivants n'en ont pas).
   Un appel sans signature (venu d'un autre fournisseur, ou d'un historique d'avant) reçoit la valeur de contournement
   documentée par Google plutôt qu'un 400 ; Gemma n'a pas de signatures. */
const BYPASS_SIGNATURE = 'skip_thought_signature_validator';

function contentsOf(messages, model = '') {
  const bypass = !String(model).startsWith('gemma-');
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message.role === 'assistant') {
      const parts = [];
      const text = message.text === undefined ? message.content : message.text;
      if (text) parts.push({ text });
      (message.toolCalls || []).forEach((call, index) => {
        const signature = call.signature || (index === 0 && bypass ? BYPASS_SIGNATURE : null);
        parts.push({ functionCall: { name: call.name, args: argsOf(call.args) }, ...(signature ? { thoughtSignature: signature } : {}) });
      });
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

/* ─────────── Recherche Google intégrée ─────────── */

const SEARCH_FUNCTION_MODES = new Set(['auto', 'combine', 'alone']);
const MAX_QUERIES = 10;
const MAX_SOURCES = 20;
const MAX_QUERY_LENGTH = 300;
const MAX_TITLE_LENGTH = 200;
const MAX_URL_LENGTH = 2048;

/**
 * L'option `googleSearch` d'une requête : `true` vaut `{ functions: 'auto' }`.
 *  - 'combine' : l'outil de recherche part avec les fonctions de l'application ;
 *  - 'alone'   : pour ce tour, la recherche seule (les fonctions ne partent pas) ;
 *  - 'auto'    : d'abord ensemble ; si l'API refuse le mélange (400), une seconde
 *                demande part avec la recherche seule.
 */
function searchOptions(value) {
  if (!value) return null;
  const functions = value === true ? 'auto' : (value.functions || 'auto');
  if (!SEARCH_FUNCTION_MODES.has(functions)) throw new TypeError('googleSearch.functions must be "auto", "combine" or "alone".');
  return { functions };
}

/* Une chaîne lue dans une page : caractères de contrôle retirés, espaces resserrés, bornée. */
function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/* Une adresse http(s) seulement, sans identifiants ; sinon null. */
function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch (_error) {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  return url.href;
}

/**
 * Les sources d'une réponse Gemini (`groundingMetadata`) : les recherches faites,
 * et les pages (titre, adresse) dédoublonnées et bornées. Accepte la réponse
 * entière de generateContent ou l'un de ses candidats. Ne lève jamais.
 * @returns {{ searched: boolean, queries: string[], sources: { title: string, url: string }[], searchSuggestionsHtml: string|null }}
 */
function readGeminiGrounding(answer) {
  const candidate = answer && Array.isArray(answer.candidates) ? answer.candidates[0] : answer;
  const metadata = (candidate && typeof candidate === 'object' && candidate.groundingMetadata) || {};
  const queries = [];
  for (const raw of Array.isArray(metadata.webSearchQueries) ? metadata.webSearchQueries : []) {
    const query = cleanLine(raw, MAX_QUERY_LENGTH);
    if (query && !queries.includes(query) && queries.length < MAX_QUERIES) queries.push(query);
  }
  const sources = [];
  for (const chunk of Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []) {
    const web = chunk && typeof chunk === 'object' ? chunk.web : null;
    const url = web ? cleanUrl(web.uri) : null;
    if (!url || sources.some((source) => source.url === url)) continue;
    const title = cleanLine(web.title, MAX_TITLE_LENGTH) || new URL(url).hostname;
    sources.push({ title, url });
    if (sources.length >= MAX_SOURCES) break;
  }
  const entry = metadata.searchEntryPoint && typeof metadata.searchEntryPoint.renderedContent === 'string'
    ? metadata.searchEntryPoint.renderedContent
    : null;
  return { searched: queries.length > 0 || sources.length > 0, queries, sources, searchSuggestionsHtml: entry };
}

/** Le corps de la requête pour un modèle. */
function requestBody(model, request, noSystemInstruction, search = null, dropFunctions = false) {
  const contents = contentsOf(request.messages, model);
  const generationConfig = {
    temperature: request.temperature === undefined ? 0.4 : request.temperature,
    maxOutputTokens: request.maxTokens || 1200
  };
  const toolList = [];
  if (request.tools && request.tools.length && !dropFunctions) toolList.push({ functionDeclarations: request.tools });
  if (search) toolList.push({ google_search: {} });
  const functions = toolList.length ? { tools: toolList } : {};
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
 * @param {{ system?: string, messages: object[], tools?: object[], maxTokens?: number, temperature?: number, googleSearch?: boolean|{ functions?: 'auto'|'combine'|'alone' } }} request
 * @param {{ key: string, fetch: Function, signal?: AbortSignal, timeoutMs?: number, endpoint?: string, noSystemInstruction?: Function }} io
 * @returns {Promise<{ status: number, text?: string|null, toolCalls?: object[], cut?: boolean, grounding?: object }>}
 *   Un refus se résout en `{ status }` — rien n'est levé pour lui. Avec
 *   `googleSearch`, la réponse porte `grounding` (voir readGeminiGrounding),
 *   plus `functionsDropped` : vrai quand les fonctions ne sont pas parties.
 */
async function askGeminiModel(model, request, io = {}) {
  if (typeof io.fetch !== 'function') throw new Error('askGeminiModel requires io.fetch.');
  const search = searchOptions(request.googleSearch);
  const hasFunctions = Boolean(request.tools && request.tools.length);
  const timeout = globalThis.AbortSignal.timeout(io.timeoutMs || DEFAULT_TIMEOUT_MS);
  const signal = io.signal ? globalThis.AbortSignal.any([io.signal, timeout]) : timeout;
  /* `onText` : la réponse en flux (streamGenerateContent), le texte montrable entier à chaque avancée. */
  const report = textReporter(io.onText);
  const method = report ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const send = (dropFunctions) => io.fetch(`${io.endpoint || DEFAULT_ENDPOINT}/${model}:${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': io.key },
    body: JSON.stringify({ ...requestBody(model, request, io.noSystemInstruction || noSystemInstructionByDefault, search, dropFunctions), ...(io.extra || {}) }),
    signal
  });
  let functionsDropped = Boolean(search && hasFunctions && search.functions === 'alone');
  let response = await send(functionsDropped);
  /* Le mélange recherche + fonctions refusé par l'API : la recherche seule, pour ce tour. */
  if (!response.ok && response.status === 400 && search && hasFunctions && search.functions === 'auto') {
    functionsDropped = true;
    response = await send(true);
  }
  if (!response.ok) {
    const retryAfterMs = readRetryAfter(response);
    return { status: response.status, ...(retryAfterMs === null ? {} : { retryAfterMs }) };
  }
  const contentType = (response.headers && typeof response.headers.get === 'function' && response.headers.get('content-type')) || '';
  const answer = report && contentType.includes('text/event-stream') ? await readGeminiStream(response, report) : await response.json();
  const candidate = (answer && answer.candidates && answer.candidates[0]) || {};
  const grounding = search ? { grounding: { ...readGeminiGrounding(candidate), functionsDropped } } : {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const toolCalls = functionsDropped ? [] : parts.filter((part) => part.functionCall).map((part, index) => ({
    id: part.functionCall.id || `call_${index}`,
    name: part.functionCall.name,
    args: argsOf(part.functionCall.args),
    ...(typeof part.thoughtSignature === 'string' && part.thoughtSignature ? { signature: part.thoughtSignature } : {})
  }));
  if (toolCalls.length) return { status: response.status, text: null, toolCalls, ...grounding };
  const text = withoutThinking(parts.filter((part) => !part.thought && !part.functionCall).map((part) => part.text || '').join(''));
  const written = readWrittenAnswer(text, hasFunctions && !functionsDropped);
  if (written) return { status: response.status, ...written, ...grounding };
  return { status: response.status, text, cut: candidate.finishReason === 'MAX_TOKENS', ...grounding };
}

/* Une réponse en flux, rassemblée en un seul candidat : ses parties (texte, réflexion, appels), sa fin, ses sources. */
async function readGeminiStream(response, report) {
  const parts = [];
  let finishReason;
  let groundingMetadata;
  let shown = '';
  await readServerEvents(response, (event) => {
    const candidate = event && Array.isArray(event.candidates) ? event.candidates[0] : null;
    if (!candidate) return;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    if (candidate.groundingMetadata) groundingMetadata = candidate.groundingMetadata;
    for (const part of (candidate.content && candidate.content.parts) || []) {
      parts.push(part);
      if (!part.thought && !part.functionCall && typeof part.text === 'string') {
        shown += part.text;
        report(shown);
      }
    }
  });
  return { candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}), ...(groundingMetadata ? { groundingMetadata } : {}) }] };
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
    ...(options.external === false ? { external: false } : {}),
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
        noSystemInstruction: options.noSystemInstruction,
        onText: ctx.onText,
        extra: { ...(options.extra || {}), ...(model.extra || {}) }
      });
      return providerResult(id, answer, options.detailed);
    }
  };
}

module.exports = { askGeminiModel, createGeminiProvider, readGeminiGrounding };
