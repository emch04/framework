'use strict';

function normalizeSpeech(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}
function hasPhrase(text, phrases) {
  const normalized = ` ${normalizeSpeech(text)} `;
  return phrases.some(phrase => normalized.includes(` ${normalizeSpeech(phrase)} `));
}
function createSpokenConfirmation({
  now,
  timeoutMs = 120000,
  affirmative = {},
  negative = {}
}) {
  let pending = null;
  let previous = null;
  return {
    propose(id) {
      pending = {
        id,
        at: now(),
        readBack: false,
        answer: ''
      };
    },
    heard({
      who,
      text
    }) {
      if (!pending) return;
      if (who === 'assistant') {
        pending.readBack = true;
      } else if (who === 'person' && pending.readBack) {
        pending.answer = previous === 'person' ? `${pending.answer} ${text}` : String(text);
      }
      previous = who;
    },
    verify(id, language) {
      if (!pending || pending.id !== id) return 'ACTION_MISSING';
      if (now() - pending.at > timeoutMs) {
        pending = null;
        return 'ACTION_EXPIRED';
      }
      if (!pending.readBack) return 'READBACK_MISSING';
      if (!pending.answer) return 'ANSWER_MISSING';
      return hasPhrase(pending.answer, affirmative[language] || []) && !hasPhrase(pending.answer, negative[language] || []) ? 'CONFIRMED' : 'CONSENT_MISSING';
    },
    clear(id) {
      if (pending?.id === id) pending = null;
    },
    get pendingId() {
      return pending && now() - pending.at <= timeoutMs ? pending.id : null;
    }
  };
}
function toolDeclarations(registry, role, catalog = {}) {
  if (!registry) return [];
  const describeParameter = description => {
    if (description && typeof description === 'object') return description;
    const label = String(description || '');
    const match = /^(number|boolean|object|string)\b/i.exec(label);
    return {
      type: match ? match[1].toLowerCase() : 'string',
      description: label
    };
  };
  const tools = registry.getToolsForRole(role).filter(tool => tool.type === 'write' || typeof tool.handler === 'function').map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(tool.params || {}).map(([name, description]) => [name, describeParameter(description)])),
      required: Object.entries(tool.params || {})
        .filter(([, description]) => {
          if (description && typeof description === 'object') {
            return description.required !== false && description.optional !== true;
          }
          return !/optional|optionnel|défaut|defaut/i.test(String(description));
        })
        .map(([name]) => name)
    }
  }));
  if (!tools.some(tool => registry.getToolByName(tool.name)?.type === 'write')) return tools;
  const parameters = {
    type: 'object',
    properties: {
      actionId: {
        type: 'string'
      }
    },
    required: ['actionId']
  };
  return [...tools, {
    name: 'confirm_action',
    description: catalog.confirmAction || 'CONFIRM_ACTION',
    parameters
  }, {
    name: 'cancel_action',
    description: catalog.cancelAction || 'CANCEL_ACTION',
    parameters
  }];
}
function createCallTools({
  registry,
  context,
  confirmation,
  actions,
  shield = {},
  clock,
  timeoutMs = 20000,
  maxResultChars = 6000,
  send = () => {},
  onResult = () => {},
  catalog = {}
}) {
  const safe = (kind, value) => typeof shield[kind] === 'function' ? shield[kind](value) : value;
  async function withTimeout(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = clock.setTimeout(() => reject({
          code: 'TOOL_TIMEOUT'
        }), timeoutMs);
      })]);
    } finally {
      clock.clearTimeout(timer);
    }
  }
  return {
    declarations: toolDeclarations(registry, context.role, catalog),
    async confirmByClient(actionId) {
      if (!actionId || confirmation.pendingId !== actionId) return {
        code: 'ACTION_MISSING'
      };
      confirmation.clear(actionId);
      try {
        const result = await actions.execute(actionId, context);
        send({
          type: 'action_done',
          actionId,
          ok: Boolean(result?.success)
        });
        return {
          code: result?.success ? 'ACTION_DONE' : 'ACTION_FAILED'
        };
      } catch (_error) {
        send({
          type: 'action_done',
          actionId,
          ok: false
        });
        return {
          code: 'ACTION_FAILED'
        };
      }
    },
    async cancelByClient(actionId) {
      if (!actionId || confirmation.pendingId !== actionId) return {
        code: 'ACTION_MISSING'
      };
      confirmation.clear(actionId);
      try {
        await actions.cancel?.(actionId, context);
      } catch (_error) {/* The pending action was cleared locally. */}
      send({
        type: 'action_cancelled',
        actionId
      });
      return {
        code: 'ACTION_CANCELLED'
      };
    },
    async call({
      name,
      args = {}
    }) {
      const tool = registry?.getToolByName(name);
      const input = await (tool?.external && typeof shield.external === 'function'
        ? shield.external(args)
        : safe(typeof shield.args === 'function' ? 'args' : 'input', args));
      if (name === 'confirm_action') {
        const verdict = confirmation.verify(input.actionId, context.language);
        if (verdict !== 'CONFIRMED') return {
          code: verdict
        };
        confirmation.clear(input.actionId);
        try {
          const result = await actions.execute(input.actionId, context);
          send({
            type: 'action_done',
            actionId: input.actionId,
            ok: Boolean(result?.success)
          });
          return {
            code: result?.success ? 'ACTION_DONE' : 'ACTION_FAILED'
          };
        } catch (_error) {
          return {
            code: 'ACTION_FAILED'
          };
        }
      }
      if (name === 'cancel_action') {
        if (confirmation.pendingId !== input.actionId) return {
          code: 'ACTION_MISSING'
        };
        confirmation.clear(input.actionId);
        try {
          await actions.cancel?.(input.actionId, context);
        } catch (_error) {/* The pending action was cleared locally. */}
        send({
          type: 'action_cancelled',
          actionId: input.actionId
        });
        return {
          code: 'ACTION_CANCELLED'
        };
      }
      if (!tool || !tool.roles.includes(context.role)) return {
        code: 'TOOL_DENIED'
      };
      if (tool.type === 'write') {
        if (!actions?.queue) return {
          code: 'ACTION_UNAVAILABLE'
        };
        try {
          const actionId = await actions.queue({
            name,
            args: input,
            context
          });
          confirmation.propose(actionId);
          send({
            type: 'confirm',
            actionId
          });
          return {
            code: 'CONFIRMATION_REQUIRED',
            actionId
          };
        } catch (_error) {
          return {
            code: 'ACTION_UNAVAILABLE'
          };
        }
      }
      try {
        const rawResult = await withTimeout(Promise.resolve().then(() => tool.handler(input, context)));
        const result = await safe(typeof shield.result === 'function' ? 'result' : 'output', rawResult);
        try {
          onResult(name, result);
        } catch (_error) {/* Annotations are optional. */}
        const serialized = JSON.stringify(result ?? null);
        return serialized.length <= maxResultChars ? result : {
          code: 'RESULT_TRUNCATED',
          value: serialized.slice(0, maxResultChars)
        };
      } catch (error) {
        return {
          code: error?.code === 'TOOL_TIMEOUT' ? 'TOOL_TIMEOUT' : 'TOOL_FAILED'
        };
      }
    }
  };
}
function buildInstructions({
  persona,
  language,
  role,
  now,
  catalog = {},
  shield
}) {
  const pieces = [persona, catalog.language?.[language], catalog.role?.[role], catalog.voice, catalog.confirmation, now?.()];
  return pieces.filter(piece => piece != null && piece !== '').map(piece => shield?.input ? shield.input(String(piece)) : String(piece)).join('\n');
}
module.exports = {
  normalizeSpeech,
  createSpokenConfirmation,
  toolDeclarations,
  createCallTools,
  buildInstructions
};
