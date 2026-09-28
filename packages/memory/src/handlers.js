/**
 * What a "my memories" screen calls, as plain functions — mount them on any
 * framework. They take the place from YOUR authentication, never from the
 * request body.
 *
 * A person must always be able to see, pause, take back and erase what the
 * assistant keeps about them — including when the AI is switched off, for a
 * school, a plan, or an outage. Those operations are listed in
 * PRIVACY_OPERATIONS and never consult `isAiEnabled`. Only editing a memory's
 * content does: an edit is a new memory, and the AI is what writes memories.
 */
const { REASONS } = require('./rules');

const PRIVACY_OPERATIONS = Object.freeze(['list', 'listUnseen', 'markSeen', 'setPaused', 'undo', 'erase', 'eraseAll', 'purgeOwner']);
const AI_OPERATIONS = Object.freeze(['update']);

/** True when the operation keeps working with the AI switched off. */
function worksWithoutAi(operation) {
  return PRIVACY_OPERATIONS.includes(operation);
}

/**
 * @param {object} options
 * @param {object} options.memory          from createMemory().
 * @param {Function} [options.isAiEnabled] (where) => boolean. Absent: always on.
 */
function createMemoryHandlers(options = {}) {
  const memory = options.memory;
  if (!memory || typeof memory.list !== 'function') throw new Error('createMemoryHandlers requires options.memory from createMemory().');
  const isAiEnabled = options.isAiEnabled || (() => true);

  return {
    async list(where) {
      const [paused, memories] = await Promise.all([memory.isPaused(where), memory.list(where)]);
      return { ok: true, paused, memories };
    },

    async listUnseen(where) {
      return { ok: true, memories: await memory.listUnseen(where) };
    },

    async markSeen(where, { ids } = {}) {
      const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
      return { ok: true, seen: await memory.markSeen(where, list) };
    },

    async setPaused(where, { paused } = {}) {
      return { ok: true, paused: await memory.setPaused(where, paused === true) };
    },

    async undo(where, { id } = {}) {
      const undone = await memory.undo(where, String(id ?? ''));
      return undone ? { ok: true, undone } : { ok: false, reason: REASONS.NOT_FOUND };
    },

    async erase(where, { id } = {}) {
      const erased = await memory.forget(where, String(id ?? ''));
      return erased ? { ok: true, erased } : { ok: false, reason: REASONS.NOT_FOUND };
    },

    async eraseAll(where) {
      return { ok: true, erased: await memory.eraseAll(where) };
    },

    /* For an account deletion job, not for a screen: every scope of the owner. */
    async purgeOwner(ownerId) {
      return { ok: true, ...(await memory.purgeOwner(ownerId)) };
    },

    /* The person edits their own memory: they are asking for it, so it counts as explicit. */
    async update(where, { id, text, kind, importance, personName } = {}) {
      if (!(await isAiEnabled(where))) return { ok: false, reason: REASONS.AI_DISABLED };
      const result = await memory.update(where, String(id ?? ''), { text, kind, importance }, { personName, explicit: true });
      return result.ok ? { ok: true, memory: result.memory, supersededId: result.supersededId } : { ok: false, reason: result.reason };
    }
  };
}

module.exports = {
  createMemoryHandlers,
  PRIVACY_OPERATIONS,
  AI_OPERATIONS,
  worksWithoutAi
};
