/**
 * The four memory tools, shaped for @astratra/ai's createToolRegistry():
 * { name, description, type, roles, params, handler(params, ctx) }.
 *
 * Results are data and codes, never sentences: `code` says what happened,
 * `reason` why a write was refused. Pass `translate(code, ctx)` to add a
 * `message` in the person's language from your own catalog.
 *
 * `forget` erases. Put it behind runAgentLoop's `confirmTool` (or
 * createPendingActions) so a person says yes first.
 */
const { REASONS } = require('./rules');

const DEFAULT_NAMES = Object.freeze({ remember: 'remember', recall: 'recall', update: 'update_memory', forget: 'forget' });

/* Instructions to the model, not text for a person. Override with `descriptions`. */
const DEFAULT_DESCRIPTIONS = Object.freeze({
  remember: 'Keeps one new durable fact about the current person for future conversations (a goal, a preference, a person in their life, an event). Use it on your own when they tell you such a thing, not for small talk. If recall shows a memory this changes, use the update tool on that memory instead.',
  recall: 'Searches the current person\'s memories by meaning and by words.',
  update: 'Corrects one memory of the current person, found with recall (give its id), when they say it changed or was wrong. The new text replaces the old one; kind and importance stay unless given.',
  forget: 'Erases one memory of the current person (give its id, found with recall). Erasing needs the person\'s confirmation.'
});

/**
 * @param {object} options
 * @param {object} options.memory      from createMemory().
 * @param {string[]} options.roles     roles that may use these tools.
 * @param {Function} options.whereOf   (ctx) => { ownerId, scope } — required: the
 *   tools never guess whose memories they touch.
 * @param {Function} [options.roleOf]        (ctx) => role. Default ctx.userRole ?? ctx.role.
 * @param {Function} [options.personNameOf]  (ctx) => the person's own name (allowed in their memories).
 * @param {Function} [options.isExplicit]    (params, ctx) => the person asked to remember this.
 * @param {Function} [options.sourceOf]      (params, ctx) => extra source fields (conversation id…).
 * @param {Function} [options.isAiEnabled]   (ctx) => boolean. Off: every tool refuses with 'ai_disabled'.
 * @param {Function} [options.translate]     (code, ctx) => string, added as `message`.
 * @param {object} [options.names]           rename the tools.
 * @param {object} [options.descriptions]    replace the model instructions.
 */
function createMemoryTools(options = {}) {
  const memory = options.memory;
  if (!memory || typeof memory.remember !== 'function') throw new Error('createMemoryTools requires options.memory from createMemory().');
  if (!Array.isArray(options.roles) || !options.roles.length) throw new Error('createMemoryTools requires options.roles.');
  if (typeof options.whereOf !== 'function') throw new Error('createMemoryTools requires options.whereOf(ctx).');

  const roles = [...options.roles];
  const whereOf = options.whereOf;
  const roleOf = options.roleOf || ((ctx) => (ctx.userRole !== undefined ? ctx.userRole : ctx.role));
  const personNameOf = options.personNameOf || (() => '');
  const isExplicit = options.isExplicit || (() => false);
  const sourceOf = options.sourceOf || (() => ({}));
  const isAiEnabled = options.isAiEnabled || null;
  const translate = options.translate || null;
  const names = { ...DEFAULT_NAMES, ...(options.names || {}) };
  const descriptions = { ...DEFAULT_DESCRIPTIONS, ...(options.descriptions || {}) };
  const kindList = memory.kinds.join('|');

  const reply = (body, ctx) => {
    if (!translate) return body;
    const key = body.ok ? body.code : `${body.code}.${body.reason}`;
    return { ...body, message: translate(key, ctx) };
  };

  const guard = (fn) => async (params = {}, ctx = {}) => {
    if (isAiEnabled && !(await isAiEnabled(ctx))) return reply({ ok: false, code: 'refused', reason: REASONS.AI_DISABLED }, ctx);
    return fn(params || {}, ctx || {});
  };

  const rememberTool = {
    name: names.remember,
    description: descriptions.remember,
    type: 'write',
    roles,
    params: { text: 'string', kind: kindList, importance: 'integer 1-5' },
    handler: guard(async (params, ctx) => {
      const result = await memory.remember(whereOf(ctx), {
        text: params.text,
        kind: params.kind,
        importance: params.importance,
        role: roleOf(ctx),
        personName: personNameOf(ctx),
        explicit: Boolean(await isExplicit(params, ctx)),
        source: sourceOf(params, ctx),
        ctx
      });
      if (!result.ok) return reply({ ok: false, code: 'refused', reason: result.reason }, ctx);
      return reply({
        ok: true,
        code: 'memory_saved',
        memory: { id: result.memory.id, text: result.memory.text, kind: result.memory.kind, importance: result.memory.importance },
        undo: { id: result.memory.id }
      }, ctx);
    })
  };

  const recallTool = {
    name: names.recall,
    description: descriptions.recall,
    type: 'read',
    roles,
    params: { query: 'string', kinds: `array of ${kindList} (optional)`, limit: 'integer 1-20 (optional)' },
    handler: guard(async (params, ctx) => {
      let found;
      try {
        found = await memory.recall(whereOf(ctx), {
          query: params.query,
          kinds: params.kinds,
          after: params.after,
          before: params.before,
          limit: params.limit === undefined ? undefined : Number(params.limit)
        });
      } catch (error) {
        if (error && error.name === 'MemoryError' && /^invalid_(after|before)$/.test(error.code)) {
          return reply({ ok: false, code: 'refused', reason: error.code }, ctx);
        }
        throw error;
      }
      return reply({
        ok: true,
        code: 'memories_found',
        memories: found.map(({ id, text, kind, importance, createdAt, lastUsedAt }) => ({ id, text, kind, importance, createdAt, lastUsedAt }))
      }, ctx);
    })
  };

  const updateTool = {
    name: names.update,
    description: descriptions.update,
    type: 'write',
    roles,
    params: { id: 'string', text: 'string', kind: `${kindList} (optional)`, importance: 'integer 1-5 (optional)' },
    handler: guard(async (params, ctx) => {
      if (await memory.isPaused(whereOf(ctx))) return reply({ ok: false, code: 'refused', reason: REASONS.PAUSED }, ctx);
      const result = await memory.update(whereOf(ctx), String(params.id ?? ''), {
        text: params.text,
        kind: params.kind,
        importance: params.importance
      }, {
        personName: personNameOf(ctx),
        explicit: Boolean(await isExplicit(params, ctx)),
        ctx
      });
      if (!result.ok) return reply({ ok: false, code: 'refused', reason: result.reason }, ctx);
      return reply({
        ok: true,
        code: 'memory_corrected',
        memory: { id: result.memory.id, text: result.memory.text, kind: result.memory.kind, importance: result.memory.importance },
        undo: result.supersededId ? { id: result.memory.id } : null
      }, ctx);
    })
  };

  const forgetTool = {
    name: names.forget,
    description: descriptions.forget,
    type: 'write',
    roles,
    params: { id: 'string' },
    handler: guard(async (params, ctx) => {
      const erased = await memory.forget(whereOf(ctx), String(params.id ?? ''));
      if (!erased) return reply({ ok: false, code: 'refused', reason: REASONS.NOT_FOUND }, ctx);
      return reply({ ok: true, code: 'memory_forgotten', id: String(params.id) }, ctx);
    })
  };

  return [rememberTool, recallTool, updateTool, forgetTool];
}

module.exports = {
  createMemoryTools,
  DEFAULT_TOOL_NAMES: DEFAULT_NAMES,
  DEFAULT_TOOL_DESCRIPTIONS: DEFAULT_DESCRIPTIONS
};
