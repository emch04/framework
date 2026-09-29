'use strict';

async function resumeConversation({
  store,
  userId,
  requestedId = null,
  now,
  windowMs = 30 * 60 * 1000,
  maxTurns = 12
}) {
  if (!store || typeof (requestedId ? store.get : store.latest) !== 'function') return null;
  let item;
  try {
    item = requestedId ? await store.get(requestedId, userId) : await store.latest(userId);
  } catch (_error) {
    return null;
  }
  if (!item || item.userId !== userId || !Number.isFinite(item.updatedAt) || now() - item.updatedAt > windowMs || item.updatedAt > now()) return null;
  return {
    id: item.id,
    turns: Array.isArray(item.turns) ? item.turns.slice(-maxTurns) : []
  };
}
function createTranscriptRecorder({
  store,
  userId,
  conversationId,
  now,
  onSaved = () => {},
  maxChars = 20000,
  completeOnly = false,
  deferLatestExchange = false
}) {
  let saved = 0;
  let queue = Promise.resolve();
  let id = conversationId || null;
  return {
    record(turns, { final = false } = {}) {
      const lastAssistant = turns.findLastIndex(turn => turn.who === 'assistant');
      let upto = completeOnly ? lastAssistant + 1 : turns.length;
      if (deferLatestExchange && !final) {
        const lastPerson = turns.findLastIndex(turn => turn.who === 'person');
        upto = Math.min(upto, Math.max(0, lastPerson));
      }
      const operation = queue.then(async () => {
        const fresh = turns.slice(saved, upto).map(turn => ({
          role: turn.who === 'person' ? 'user' : 'assistant',
          text: String(turn.text || '').trim().slice(0, maxChars),
          ...(turn.annotations ? {
            annotations: turn.annotations
          } : {})
        })).filter(turn => turn.text);
        if (!fresh.length || !store) return;
        if (!id) {
          if (!fresh.some(turn => turn.role === 'user')) return;
          id = await store.create({
            userId,
            updatedAt: now(),
            turns: [],
            /* What the conversation begins with: a host titles it after that. */
            first: fresh.find(turn => turn.role === 'user')
          });
          onSaved(id);
        }
        await store.append(id, userId, fresh, now());
        saved = upto;
      });
      queue = operation.catch(() => {});
      return operation;
    },
    async kept() {
      await queue;
      return id;
    }
  };
}
async function consolidateAfterCall(memory, where, transcript, id, logger = {}) {
  if (!memory || typeof memory.consolidate !== 'function' || !id || !transcript.length) return {
    status: 'skipped'
  };
  try {
    return await memory.consolidate(where, {
      transcript,
      ref: id
    });
  } catch (error) {
    logger.warn?.('CONSOLIDATION_FAILED', {
      code: error?.code
    });
    return {
      status: 'failed'
    };
  }
}
module.exports = {
  resumeConversation,
  createTranscriptRecorder,
  consolidateAfterCall
};
