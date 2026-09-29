/**
 * Des outils demandés par le modèle lui-même (function calling natif), et la
 * boucle qui les fait tourner.
 *
 * `runAgentLoop` lit un protocole écrit dans le texte (<tool_call name="…">) ;
 * ici le fournisseur rend des appels structurés, plusieurs à la fois, et la
 * transcription garde des messages typés (assistant avec ses appels, un
 * message `tool` par résultat). Ce que l'usage a appris :
 *
 *   - un outil qui échoue ou tarde devient une erreur que le modèle LIT, jamais
 *     une boucle cassée — il peut redemander autrement ;
 *   - un outil inventé, ou des arguments illisibles, n'exécutent rien : le
 *     modèle lit pourquoi, et le plus souvent se corrige au tour suivant ;
 *   - ce qu'un outil rend au modèle est borné : une page entière noierait la
 *     conversation ;
 *   - un outil « à confirmer » n'écrit rien : il prépare, un humain dispose. Le
 *     modèle lit que rien n'est encore fait ;
 *   - la personne qui part arrête tout, outils compris ;
 *   - à court de tours ou de temps, un dernier tour sans outils répond avec ce
 *     qui a été lu, plutôt qu'une erreur.
 *
 * Un outil : { name, description, parameters (schéma JSON d'un objet), kind,
 * summary?(args), run(args, ctx) }, avec perform(args, ctx) quand son genre est
 * 'confirm' (l'écriture, une fois confirmée) et undo(annulation, ctx) quand il
 * est 'write' (il écrit seul, on peut revenir dessus). `summary` donne les
 * valeurs de la ligne d'étape que l'interface écrit elle-même : le serveur
 * n'écrit aucune phrase que la personne lit.
 */

const { AppError } = require('@astratra/core');

const KINDS = ['read', 'write', 'confirm'];
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_PARAM_MAX = 120;
const DEFAULT_RESULT_MAX = 6000;
const DEFAULT_TOOL_MS = 20_000;

const MESSAGES = {
  unknownTool: (name) => `There is no tool called ${name}.`,
  timeout: () => 'This tool took too long to answer.',
  invalidArguments: (call) => (call.invalidReason === 'not_object'
    ? 'The arguments of this call must be a JSON object: call the tool again with one.'
    : `The arguments of this call were not valid JSON${call.invalidDetail ? ` (${call.invalidDetail})` : ''}: call the tool again with a JSON object.`),
  waiting: 'Nothing is written yet: the person must confirm it.'
};

const isValue = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Vérifie un catalogue d'outils. Un outil qui rompt le contrat arrête le
 * serveur au démarrage, pas la personne au milieu d'une question.
 *
 * @param {object[]} tools
 * @param {object} [options]
 * @param {string[]} [options.kinds]       Défaut read, write, confirm.
 * @param {boolean} [options.requireSummary] chaque outil donne les valeurs de sa ligne d'étape. Défaut false.
 * @returns {object[]} les mêmes outils
 * @throws {Error} nommant le premier outil fautif, et pourquoi
 */
function validateNativeTools(tools, options = {}) {
  const kinds = options.kinds || KINDS;
  const seen = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const label = typeof tool?.name === 'string' && tool.name ? tool.name : JSON.stringify(tool?.name);
    const refuse = (reason) => {
      throw new Error(`The agent tool ${label} is not valid: ${reason}.`);
    };
    if (typeof tool?.name !== 'string' || !NAME.test(tool.name)) refuse('its name is not in snake_case');
    if (seen.has(tool.name)) throw new Error(`The agent tool ${tool.name} is declared twice.`);
    seen.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim()) refuse('it has no description');
    if (tool.parameters?.type !== 'object') refuse('its parameters are not the schema of an object');
    if (!kinds.includes(tool.kind)) refuse(`its kind is not one of ${kinds.join(', ')}`);
    if (tool.summary !== undefined || options.requireSummary) {
      if (typeof tool.summary !== 'function') refuse('its summary is not a function');
      let values;
      try {
        values = tool.summary({});
      } catch (_error) {
        refuse('its summary fails without arguments');
      }
      if (!isPlain(values) || !Object.values(values).every(isValue)) refuse('its summary does not give an object of strings and numbers');
    }
    if (typeof tool.run !== 'function') refuse('its run is not a function');
    if (tool.kind === 'confirm' && typeof tool.perform !== 'function') refuse('a tool to confirm needs perform');
    if (tool.kind === 'write' && typeof tool.undo !== 'function') refuse('a tool that writes alone needs undo');
  }
  return tools;
}

/** Ce que le modèle voit de chaque outil : son nom, sa description, ses paramètres. */
const toolSpecs = (tools) => tools.map(({ name, description, parameters }) => ({ name, description, parameters }));

/**
 * Les valeurs de la ligne d'étape d'un outil pour ces arguments : chaînes et
 * nombres seulement, chacune coupée à `max` caractères ; {} quand le résumé échoue.
 * @returns {Record<string, string | number>}
 */
function stepParams(tool, args, { max = DEFAULT_PARAM_MAX } = {}) {
  if (!tool || typeof tool.summary !== 'function') return {};
  let values;
  try {
    values = tool.summary(args ?? {});
  } catch (_error) {
    return {};
  }
  if (!isPlain(values)) return {};
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => isValue(value))
      .map(([key, value]) => [key, typeof value === 'string' && value.length > max ? `${value.slice(0, max - 1)}…` : value])
  );
}

class ToolTimeout extends Error {}

/* Une promesse qui abandonne quand le signal s'interrompt, avec la raison du signal. */
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * Le lanceur d'outils du modèle, partagé par tout ce qui fait appeler des
 * outils (une conversation écrite, un appel vocal).
 *
 * @param {object} options
 * @param {Map<string, object>|object[]} options.tools
 * @param {object} [options.context]  donné à chaque outil (run(args, { ...context, signal })).
 * @param {AbortSignal} [options.signal] la personne est partie : l'appel lève sa raison.
 * @param {number} [options.timeoutMs] par outil. Défaut 20 s.
 * @param {Function} [options.now]
 * @param {Function} [options.emit]  (type, data) : 'step' { id, tool, params } puis 'step_done' { id, ok }.
 * @param {Function} [options.keep]  (sources, data) : ce qu'un outil a trouvé (createSourceLedger().keep).
 * @param {Function} [options.record] async ({ tool, args, found }) : garder une action (à confirmer, à annuler).
 * @param {Function} [options.onCall] ({ name, ms, ok }) : pour mesurer.
 * @param {number} [options.resultMax] caractères de JSON rendus au modèle. Défaut 6000.
 * @param {object} [options.messages] { unknownTool(name), timeout(), invalidArguments(call), waiting } — ce que lit le modèle.
 * @returns {(call: { id: string, name: string, args: object|null, invalid?: boolean }) => Promise<{ role: 'tool', toolCallId: string, name: string, result: unknown }>}
 */
function createToolCaller(options = {}) {
  const tools = options.tools instanceof Map
    ? options.tools
    : new Map((options.tools || []).map((tool) => [tool.name, tool]));
  const context = options.context || {};
  const signal = options.signal || new globalThis.AbortController().signal;
  const timeoutMs = options.timeoutMs || DEFAULT_TOOL_MS;
  const now = options.now || Date.now;
  const emit = options.emit || (() => {});
  const keep = options.keep || (() => {});
  const record = options.record || null;
  const onCall = options.onCall || (() => {});
  const resultMax = options.resultMax || DEFAULT_RESULT_MAX;
  const messages = { ...MESSAGES, ...(options.messages || {}) };
  let steps = 0;

  function bounded(data) {
    const json = JSON.stringify(data ?? null);
    return json.length > resultMax ? `${json.slice(0, resultMax)}…` : data;
  }

  return async function call({ id, name, args, invalid, invalidReason, invalidDetail }) {
    const tool = tools.get(name);
    const step = `s${(steps += 1)}`;
    /* Un outil inventé, ou un résumé qui échoue, montre quand même son étape, sans valeurs. */
    emit('step', { id: step, tool: name, params: stepParams(tool, args) });
    const begun = now();
    const timeout = new globalThis.AbortController();
    const timer = setTimeout(() => timeout.abort(new ToolTimeout(messages.timeout())), timeoutMs);
    let result;
    let ok = true;
    try {
      if (!tool) throw new Error(messages.unknownTool(name));
      if (invalid) throw new Error(messages.invalidArguments({ name, invalidReason, invalidDetail }));
      const toolSignal = globalThis.AbortSignal.any([signal, timeout.signal]);
      const found = await abortable(Promise.resolve().then(() => tool.run(args, { ...context, signal: toolSignal })), toolSignal);
      keep(found?.sources, found?.data);
      if (record) await record({ tool, args, found: found ?? {} });
      result = tool.kind === 'confirm' ? { data: bounded(found?.data), status: messages.waiting } : bounded(found?.data);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      ok = false;
      result = { error: error.message };
    } finally {
      clearTimeout(timer);
    }
    onCall({ name, ms: now() - begun, ok });
    emit('step_done', { id: step, ok });
    return { role: 'tool', toolCallId: id, name, result };
  };
}

/**
 * La boucle : le modèle lit la question avec la liste des outils, en demande,
 * lit ce qu'ils rendent, et recommence jusqu'à répondre.
 *
 * @param {object} options
 * @param {string} options.system
 * @param {object[]} options.messages  la transcription (modifiée en place : les tours s'y ajoutent).
 * @param {object[]} [options.tools]   ce que voit le modèle (toolSpecs).
 * @param {Function} options.turn      async ({ system, messages, tools }) => { text, toolCalls, model? }.
 * @param {Function} options.callTool  un appel => le message `tool` (createToolCaller).
 * @param {number} [options.maxTurns]  tours avec outils. Défaut 6.
 * @param {number} [options.maxMs]     budget de temps. Défaut 60 s.
 * @param {string} [options.finalInstruction] ajoutée à la consigne du dernier tour, sans outils.
 * @param {Function} [options.now]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ text: string, turns: number }>}
 * @throws {AppError} code 'AI_NO_ANSWER' quand un tour ne donne ni texte ni outil
 */
async function runToolLoop(options = {}) {
  const { system, messages, turn, callTool } = options;
  if (typeof turn !== 'function') throw new Error('runToolLoop requires options.turn.');
  if (typeof callTool !== 'function') throw new Error('runToolLoop requires options.callTool.');
  if (!Array.isArray(messages)) throw new Error('runToolLoop requires options.messages.');
  const tools = options.tools || [];
  const maxTurns = options.maxTurns === undefined ? 6 : options.maxTurns;
  const maxMs = options.maxMs === undefined ? 60_000 : options.maxMs;
  const now = options.now || Date.now;
  const signal = options.signal;
  const started = now();
  let turns = 0;

  const answerOf = (response) => {
    if (!response || !response.text) {
      const error = new AppError(`${(response && response.model) || 'The model'} gave no text.`, 503);
      error.code = 'AI_NO_ANSWER';
      throw error;
    }
    return { text: response.text, turns };
  };

  while (turns < maxTurns && now() - started < maxMs) {
    if (signal && signal.aborted) throw signal.reason;
    turns += 1;
    const response = await turn({ system, messages, tools });
    const calls = (response && response.toolCalls) || [];
    if (!calls.length) return answerOf(response);
    messages.push({ role: 'assistant', text: response.text ?? null, toolCalls: calls });
    /* Les outils demandés ensemble tournent en même temps ; leurs résultats gardent l'ordre des appels. */
    messages.push(...(await Promise.all(calls.map(callTool))));
  }
  if (signal && signal.aborted) throw signal.reason;
  turns += 1;
  const final = typeof options.finalInstruction === 'string' && options.finalInstruction.trim()
    ? `${system}\n${options.finalInstruction}`
    : system;
  return answerOf(await turn({ system: final, messages, tools: [] }));
}

module.exports = { validateNativeTools, toolSpecs, stepParams, createToolCaller, runToolLoop, NATIVE_TOOL_KINDS: KINDS };
