'use strict';
// Queue of proposed actions waiting for a person's decision. Detached from any running task: an action is
// proposed now and decided hours or days later. The package never authenticates the decider: the caller does,
// then passes the identity (and an `authorize` callback for roles). The action runs once, by the caller's executor.
const { randomUUID } = require('node:crypto');

const STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired']);
class ApprovalError extends Error {
  constructor(code, message, options) { super(message || code, options); this.name = 'ApprovalError'; this.code = code; }
}
/** Thrown by an executor that declines to act (incomplete record, amount too high…): nothing happened, the action stays pending. */
class ApprovalRefused extends Error {
  constructor(reason, details) { super(reason); this.name = 'ApprovalRefused'; this.reason = reason; this.details = details ?? null; }
}
const copy = (value) => value == null ? null : JSON.parse(JSON.stringify(value));
const toMs = (value) => value instanceof Date ? value.getTime() : value;
const who = (decider) => typeof decider === 'string' ? decider : decider?.id;

function createMemoryApprovalStore() {
  const actions = new Map();
  const out = (a) => copy(a);
  return {
    async create(action) { if (actions.has(action.id)) throw new Error('Action already exists.'); actions.set(action.id, copy(action)); return out(action); },
    async get(id) { return out(actions.get(id)); },
    async list({ status, type, requestedBy, limit = 50, before } = {}) {
      return [...actions.values()]
        .filter((a) => (!status || a.status === status) && (!type || a.type === type) && (!requestedBy || a.requestedBy === requestedBy) && (before == null || a.createdAt < before))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).slice(0, limit).map(out);
    },
    // Each transition below is one atomic step: it returns the action, or null when the condition no longer holds.
    async reserve(id, decidedBy, at, decisionInput = null) {
      const a = actions.get(id);
      if (!a || a.status !== 'pending' || (a.expiresAt != null && a.expiresAt <= at)) return null;
      Object.assign(a, { status: 'approved', decidedBy, decidedAt: at, executedAt: null, decisionInput: copy(decisionInput) }); return out(a);
    },
    async finish(id, result, at) {
      const a = actions.get(id);
      if (!a || a.status !== 'approved' || a.executedAt != null) return null;
      Object.assign(a, { result: copy(result), executedAt: at }); return out(a);
    },
    async revert(id, decidedBy, refusal) {
      const a = actions.get(id);
      if (!a || a.status !== 'approved' || a.decidedBy !== decidedBy || a.executedAt != null) return null;
      Object.assign(a, { status: 'pending', decidedBy: null, decidedAt: null, decisionInput: null, refusal: copy(refusal) }); return out(a);
    },
    async reject(id, decidedBy, reason, at) {
      const a = actions.get(id);
      if (!a || a.status !== 'pending' || (a.expiresAt != null && a.expiresAt <= at)) return null;
      Object.assign(a, { status: 'rejected', decidedBy, decidedAt: at, reason: reason ?? null }); return out(a);
    },
    async expire(at) {
      const expired = [];
      for (const a of actions.values()) if (a.status === 'pending' && a.expiresAt != null && a.expiresAt <= at) { Object.assign(a, { status: 'expired', decidedAt: at }); expired.push(out(a)); }
      return expired;
    }
  };
}
function createApprovalQueue(options = {}) {
  const store = options.store ?? createMemoryApprovalStore();
  const now = () => toMs((options.now ?? Date.now)());
  const executors = options.executors;
  if (executors != null && typeof executors !== 'function' && (typeof executors !== 'object' || Object.values(executors).some((f) => typeof f !== 'function'))) throw new Error('executors must be a function or an object of functions by action type.');
  for (const name of ['authorize', 'beforeExecute', 'onEvent', 'validateInput']) if (options[name] != null && typeof options[name] !== 'function') throw new Error(`${name} must be a function.`);
  const executionTimeoutMs = options.executionTimeoutMs ?? 30000;
  const emit = (type, action, extra) => { try { void Promise.resolve(options.onEvent?.({ type, action, ...extra })).catch(() => {}); } catch (_error) { /* An observer never breaks the queue. */ } };
  const executorFor = (type) => typeof executors === 'function' ? executors : executors?.[type];

  async function expire() {
    const expired = await store.expire(now());
    for (const action of expired) emit('expired', action);
    return expired;
  }
  async function pendingOrThrow(id) {
    const action = await store.get(id);
    if (!action) throw new ApprovalError('not_found');
    if (action.status === 'expired' || (action.status === 'pending' && action.expiresAt != null && action.expiresAt <= now())) throw new ApprovalError('expired');
    if (action.status !== 'pending') throw new ApprovalError('already_decided');
    return action;
  }
  async function authorize(action, decider, decision) {
    if (!who(decider)) throw new ApprovalError('invalid', 'decider is required.');
    if (!options.authorize) return;
    let allowed;
    try { allowed = await options.authorize({ action, decider, decision }); } catch (error) { throw new ApprovalError('forbidden', 'Not allowed to decide this action.', { cause: error }); }
    if (allowed === false) throw new ApprovalError('forbidden', 'Not allowed to decide this action.');
  }
  return {
    /** Records a proposed action. `ttlMs` or `expiresAt` (ms or Date) set its expiry; without either it never expires. */
    async propose({ type, input = {}, requestedBy, ttlMs, expiresAt, meta, id = randomUUID() } = {}) {
      if (typeof type !== 'string' || !type) throw new ApprovalError('invalid', 'type is required.');
      if (typeof requestedBy !== 'string' || !requestedBy) throw new ApprovalError('invalid', 'requestedBy is required.');
      if (executors && typeof executors === 'object' && !executors[type]) throw new ApprovalError('no_executor', `No executor for ${type}.`);
      const at = now();
      const expiry = expiresAt != null ? toMs(expiresAt) : ttlMs != null ? at + ttlMs : null;
      if (expiry != null && (!Number.isFinite(expiry) || expiry <= at)) throw new ApprovalError('invalid', 'The expiry must be in the future.');
      const action = await store.create({ id, type, input: copy(input), requestedBy, meta: copy(meta), status: 'pending', createdAt: at, expiresAt: expiry, decidedBy: null, decidedAt: null, executedAt: null, result: null, reason: null, refusal: null, decisionInput: null });
      emit('proposed', action);
      return action;
    },
    get: (id) => store.get(id),
    /** Lists actions, most recent first. Expired ones are swept first. */
    async list(filter) { await expire(); return store.list(filter); },
    /** Marks the pending actions past their expiry as `expired`. Safe to call from a timer or a scheduler task. */
    expire,
    /**
     * Approves and executes. The action is reserved atomically first, so concurrent approvals run it once.
     * `input` (optional): the action as the person read and corrected it; checked by `validateInput`, recorded as
     * `decisionInput` before the execution and given to the executor as `input` (the proposal stays as `proposedInput`).
     * The executor (`({ action, input, proposedInput, decider, signal, idempotencyKey })`) may throw ApprovalRefused or any error:
     * the action then goes back to `pending` with `refusal` set and the error is rethrown. Resolves `{ action, result }`.
     */
    async approve(id, { decider, signal, input } = {}) {
      await expire();
      const pending = await pendingOrThrow(id);
      // `input`: the action as the person read and corrected it. Checked here, recorded with the decision before
      // anything runs, then given to the executor in place of the proposed input (kept intact for the record).
      const hasDecisionInput = input !== undefined;
      let decisionInput = null;
      if (hasDecisionInput) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ApprovalError('invalid', 'input must be an object.');
        decisionInput = copy(input);
        if (options.validateInput) {
          let verdict;
          try { verdict = await options.validateInput({ action: pending, input: decisionInput, decider }); } catch (error) { throw new ApprovalError('invalid', 'The corrected input is not valid.', { cause: error }); }
          if (verdict === false) throw new ApprovalError('invalid', 'The corrected input is not valid.');
          if (verdict && typeof verdict === 'object' && 'value' in verdict) decisionInput = copy(verdict.value);
        }
      }
      await authorize(hasDecisionInput ? { ...pending, decisionInput } : pending, decider, 'approve');
      const execute = executorFor(pending.type);
      if (!execute) throw new ApprovalError('no_executor', `No executor for ${pending.type}.`);
      const by = who(decider);
      const action = await store.reserve(id, by, now(), decisionInput);
      if (!action) { await pendingOrThrow(id); throw new ApprovalError('already_decided'); } // Lost the race: say why.
      const back = async (refusal) => { await store.revert(id, by, { ...refusal, at: now(), by }); };
      if (hasDecisionInput && action.decisionInput === undefined) {
        // A store written before decision inputs: it would run the action without keeping what was approved.
        await back({ reason: 'store_without_decision_input', details: null });
        throw new ApprovalError('invalid', 'This approval store does not record a decision input (reserve() must store its 4th argument).');
      }
      let result;
      try {
        await options.beforeExecute?.({ action, decider });
        result = copy(await execute({ action, input: action.decisionInput ?? action.input, proposedInput: action.input, decider, idempotencyKey: action.id, signal: signal ?? globalThis.AbortSignal.timeout(executionTimeoutMs) }));
      } catch (error) {
        if (error instanceof ApprovalRefused) { await back({ reason: error.reason, details: error.details }); emit('refused', action, { reason: error.reason }); throw error; }
        if (error instanceof ApprovalError) { await back({ reason: error.code, details: null }); throw error; }
        await back({ reason: 'execution_failed', details: null });
        emit('failed', action, { error: String(error?.message ?? error) });
        throw new ApprovalError('execution_failed', 'The execution failed.', { cause: error });
      }
      const finished = await store.finish(id, result, now());
      emit('approved', finished, { result });
      return { action: finished, result };
    },
    /** Rejects a pending action. Resolves the rejected action. */
    async reject(id, { decider, reason } = {}) {
      await expire();
      const pending = await pendingOrThrow(id);
      await authorize(pending, decider, 'reject');
      const action = await store.reject(id, who(decider), reason ?? null, now());
      if (!action) { await pendingOrThrow(id); throw new ApprovalError('already_decided'); }
      emit('rejected', action);
      return action;
    }
  };
}
module.exports = { APPROVAL_STATUSES: STATUSES, ApprovalError, ApprovalRefused, createApprovalQueue, createMemoryApprovalStore };
