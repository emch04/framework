'use strict';
const { createGuards } = require('./createGuards');

/**
 * The preset: every check on, `failClosed` for anything that acts, a lower
 * injection threshold before an action (0.3: flagged content only goes to
 * review) than for plain reading (0.5), personal-data leaks blocked, unsafe
 * replies blocked, unsupported claims flagged. Pass `readOnly: true` for an
 * agent that cannot act: it then fails open when a model of the service is down.
 *
 * @param {object} options { models, onEvent?, names?, readOnly?, verifySources?, policy?, injection?, output? }
 */
function recommendedGuards(options = {}) {
  const { readOnly, policy, injection, output, ...rest } = options;
  return createGuards({
    defaultMode: readOnly ? 'read' : 'action',
    ...rest,
    policy: {
      failure: { action: 'failClosed', read: readOnly ? 'failOpen' : 'failClosed' },
      onInjection: 'flag',
      onLeak: 'block',
      onModeration: 'block',
      onUnsupported: 'flag',
      ...(policy || {})
    },
    injection: { threshold: 0.5, actionThreshold: 0.3, ...(injection || {}) },
    output: { grounding: true, leak: true, moderation: true, minSupport: 0.6, ...(output || {}) }
  });
}

module.exports = { recommendedGuards };
