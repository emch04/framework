'use strict';
const { randomUUID } = require('node:crypto');
const { runToolLoop, createToolCaller, toolSpecs, validateNativeTools } = require('@astratra/ai');
const { normalizeBudget, usageOf, budgetReason } = require('./budget');
const { createPlanTool } = require('./plan');
const { summarizeContext } = require('./context');
const { createMemoryTaskStore } = require('./taskStore');

class BudgetStop extends Error {}
class ConfirmationStop extends Error {}
function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
function createAgent(options = {}) {
  if (typeof options.turn !== 'function') throw new Error('turn is required.');
  const store = options.store || createMemoryTaskStore();
  const budget = normalizeBudget(options.budget);
  const maxRetries = options.maxVerificationRetries ?? 3;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('maxVerificationRetries must be a non-negative integer.');
  const leaseMs = options.leaseMs ?? 30000;
  const finalMs = options.finalMs ?? 30000;
  if (!Number.isFinite(leaseMs) || leaseMs < 30 || !Number.isFinite(finalMs) || finalMs <= 0) throw new Error('Invalid leaseMs or finalMs.');
  validateNativeTools(options.tools || []);
  if ((options.tools || []).some((tool) => tool.name === 'update_plan')) throw new Error('update_plan is reserved.');
  const now = options.now || Date.now;
  const feedback = options.feedback;
  if (feedback != null && typeof feedback !== 'function' && typeof feedback.feedbackDigest !== 'function' && typeof feedback.digest !== 'function') throw new Error('feedback must be a function or an object with feedbackDigest().');
  const digestOf = feedback && (typeof feedback === 'function' ? feedback : (input) => (feedback.feedbackDigest || feedback.digest).call(feedback, input));
  const emit = async (type, data) => { if (options.onEvent) await options.onEvent({ type, ...JSON.parse(JSON.stringify(data)) }); };
  async function create({ id = randomUUID(), question, messages = [], userId, tenantId }) {
    if (typeof question !== 'string' || !question.trim()) throw new Error('question is required.');
    if (tenantId != null && (typeof tenantId !== 'string' || !tenantId || tenantId.length > 200)) throw new Error('tenantId must be a non-empty string of at most 200 characters.');
    if (userId != null && (typeof userId !== 'string' || !userId || userId.length > 200)) throw new Error('userId must be a non-empty string of at most 200 characters.');
    return store.create({ id, question, ...(userId != null ? { userId } : {}), ...(tenantId != null ? { tenantId } : {}), messages: [...messages, { role: 'user', text: question }], plan: [], state: 'pending', turns: 0, elapsedMs: 0, usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, usageHistory: [], steps: [], pending: null, verificationRetries: 0, verified: false, createdAt: now(), updatedAt: now() });
  }
  async function resume(id, { signal: externalSignal, confirmation } = {}) {
    const owner = randomUUID();
    if (!await store.acquire(id, owner, leaseMs)) throw new Error('Task is missing or already locked.');
    let task;
    let heartbeat;
    let deadline;
    const controller = new globalThis.AbortController();
    const signal = externalSignal ? globalThis.AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    const began = now();
    let elapsed = 0;
    let queue = Promise.resolve();
    const save = async () => {
      task.elapsedMs = elapsed + Math.max(0, now() - began);
      task.updatedAt = now();
      await store.save(task, owner);
    };
    try {
      task = await store.get(id);
      elapsed = task.elapsedMs;
      if (['completed', 'cancelled'].includes(task.state)) return task;
      if (task.state === 'waiting_confirmation' && !confirmation) return task;
      task.state = 'running';
      await save();
      heartbeat = setInterval(() => {
        store.renew(id, owner, leaseMs).then((ok) => { if (!ok) controller.abort(new Error('Task lock lost.')); }, (error) => controller.abort(error));
      }, Math.max(10, Math.floor(leaseMs / 3)));
      deadline = setTimeout(() => controller.abort(new BudgetStop('time')), Math.max(0, budget.maxMs - task.elapsedMs));
      const tools = [...(options.tools || []), createPlanTool(async (plan) => { signal.throwIfAborted(); task.plan = plan; await save(); await emit('plan', { taskId: id, plan }); })];
      async function execute(call) {
        signal.throwIfAborted();
        task.elapsedMs = elapsed + Math.max(0, now() - began);
        const reason = budgetReason(task, budget);
        if (reason) throw new BudgetStop(reason);
        const index = task.pending.calls.findIndex((item) => item.id === call.id);
        if (task.pending.results[index]) return task.pending.results[index];
        const key = `${id}:${task.pending.step}:${index}`;
        const tool = tools.find((item) => item.name === call.name);
        let result;
        if (tool?.kind === 'confirm') {
          task.pending.preparations ||= [];
          if (!task.pending.preparations[index]) {
            const prepared = await createToolCaller({ tools: [tool], context: { ...(options.context || {}), taskId: id, idempotencyKey: key }, signal, timeoutMs: options.toolTimeoutMs })(call);
            task.pending.preparations[index] = prepared;
            await save();
          }
          const prepared = task.pending.preparations[index];
          if (prepared.result?.error) {
            task.pending.results[index] = prepared;
            task.steps.push({ key, call, result: prepared });
            await save(); await emit('step', { taskId: id, key, call, result: prepared });
            return prepared;
          }
          if (!confirmation || confirmation.key !== key) {
            task.state = 'waiting_confirmation'; task.confirmation = { key, call, prepared: prepared.result };
            await save(); await emit('confirmation', { taskId: id, confirmation: task.confirmation });
            throw new ConfirmationStop();
          }
          if (confirmation.approved) {
            const approved = { ...tool, kind: 'read', run: tool.perform };
            result = await createToolCaller({ tools: [approved], context: { ...(options.context || {}), taskId: id, idempotencyKey: key }, signal, timeoutMs: options.toolTimeoutMs })(call);
          } else result = { role: 'tool', toolCallId: call.id, name: call.name, result: { status: 'rejected' } };
          delete task.confirmation;
          confirmation = undefined;
        } else {
          result = await createToolCaller({ tools, context: { ...(options.context || {}), taskId: id, idempotencyKey: key }, signal, timeoutMs: options.toolTimeoutMs })(call);
        }
        task.pending.results[index] = result;
        task.steps.push({ key, call, result });
        await save(); await emit('step', { taskId: id, key, call, result });
        return result;
      }
      const callTool = (call) => {
        const next = queue.then(() => execute(call));
        queue = next;
        return next;
      };
      async function model(request, activeSignal = signal, reserve = false, phase = 'execution') {
        activeSignal.throwIfAborted();
        task.elapsedMs = elapsed + Math.max(0, now() - began);
        const reason = budgetReason(task, budget);
        if (!reserve && reason) throw new BudgetStop(reason);
        task.turns += 1;
        await save();
        const response = await abortable(() => options.turn({ ...request, signal: activeSignal, phase }), activeSignal);
        activeSignal.throwIfAborted();
        const usage = usageOf(request, response, options.pricing);
        for (const field of ['inputTokens', 'outputTokens', 'cost']) task.usage[field] += usage[field];
        task.usageHistory.push({ turn: task.turns, phase, ...usage });
        if (phase === 'execution' && response.toolCalls?.length) {
          const ids = response.toolCalls.map((call) => call.id);
          if (ids.some((value) => typeof value !== 'string' || !value) || new Set(ids).size !== ids.length) throw new Error('Tool calls need unique non-empty ids.');
          task.pending = { step: task.turns, calls: response.toolCalls, results: [] };
          task.messages = JSON.parse(JSON.stringify(task.messages));
          task.messages.push({ role: 'assistant', text: response.text ?? null, toolCalls: response.toolCalls });
        }
        await save(); await emit('usage', { taskId: id, turn: task.turns, phase, usage, total: task.usage });
        return response;
      }
      // The person's recent dislikes, computed once per task and kept so a resumed task sees the same prompt.
      if (digestOf && task.feedbackDigest === undefined && (task.userId || typeof feedback === 'function')) {
        let text = '';
        try { const value = await abortable(() => digestOf({ userId: task.userId, tenantId: task.tenantId, task: JSON.parse(JSON.stringify(task)), signal }), signal); if (typeof value === 'string') text = value.trim().slice(0, 4000); } catch (_error) { signal.throwIfAborted(); }
        task.feedbackDigest = text; await save();
      }
      await emit('run', { taskId: id, runId: id });
      const system = () => `${options.system || ''}${task.feedbackDigest ? `\n${task.feedbackDigest}` : ''}\nTask: ${task.question}\nCurrent plan: ${JSON.stringify(task.plan)}`;
      const summarize = options.summarize || (async ({ messages, plan }) => {
        const response = await model({ system: options.summaryInstruction || 'Summarize the completed work, evidence, constraints and remaining work. Preserve references needed to continue.', messages: [...messages, { role: 'system', text: JSON.stringify(plan) }], tools: [] }, signal, false, 'summary');
        return response.text;
      });
      let text;
      try {
        if (task.pending) {
          const results = [];
          for (const call of task.pending.calls) results.push(await callTool(call));
          task.messages.push(...results); task.pending = null; await save();
        }
        while (true) {
          signal.throwIfAborted();
          if (options.contextSummary && await summarizeContext(task.messages, task.plan, options.contextSummary, (input) => abortable(() => summarize({ ...input, signal }), signal))) {
            await save(); await emit('summary', { taskId: id, messages: task.messages });
          }
          // runToolLoop owns tool dispatch and transcript ordering. The wrapper checkpoints each turn.
          const local = task.messages.map((message) => JSON.parse(JSON.stringify(message)));
          const response = await runToolLoop({ system: system(), messages: local, tools: toolSpecs(tools), maxTurns: Number.MAX_SAFE_INTEGER, maxMs: Number.MAX_SAFE_INTEGER, signal, callTool, turn: async (request) => {
            if (task.pending) { task.messages = request.messages; task.pending = null; await save(); }
            else task.messages = request.messages;
            return model({ ...request, system: system() });
          } });
          text = response.text;
          task.messages.push({ role: 'assistant', text }); await save();
          let verdict = { complete: true };
          if (options.verify) verdict = await abortable(() => options.verify({ task: JSON.parse(JSON.stringify(task)), text, signal }), signal);
          else if (options.verificationInstruction) {
            const checked = await model({ system: `${options.verificationInstruction}\nReturn JSON: {"complete": boolean, "feedback": string}.`, messages: task.messages, tools: [] }, signal, false, 'verification');
            verdict = JSON.parse(checked.text);
          }
          if (typeof verdict === 'boolean') verdict = { complete: verdict };
          if (!verdict || typeof verdict.complete !== 'boolean') throw new Error('Verification must return a boolean or { complete, feedback }.');
          task.verified = verdict.complete; await save(); await emit('verification', { taskId: id, verdict });
          if (verdict.complete) break;
          if (task.verificationRetries >= maxRetries) { task.stopReason = 'verification'; break; }
          task.verificationRetries += 1;
          task.messages.push({ role: 'user', text: verdict.feedback || 'The task is incomplete. Finish the remaining work and verify it.' }); await save();
        }
      } catch (error) {
        if (!(error instanceof BudgetStop)) throw error;
        task.stopReason = error.message;
        clearTimeout(deadline);
        const finalController = new globalThis.AbortController();
        const finalSignal = externalSignal ? globalThis.AbortSignal.any([externalSignal, finalController.signal]) : finalController.signal;
        const timer = setTimeout(() => finalController.abort(new Error('Final response timed out.')), finalMs);
        try {
          const finalMessages = JSON.parse(JSON.stringify(task.messages));
          if (task.pending) finalMessages.push(...task.pending.calls.map((call, index) => task.pending.results[index] || { role: 'tool', toolCallId: call.id, name: call.name, result: { error: 'Not executed: task budget exhausted.' } }));
          const response = await model({ system: `${system()}\n${options.finalInstruction || 'The task budget is exhausted. Give a final answer stating completed work and remaining work accurately.'}`, messages: finalMessages, tools: [] }, finalSignal, true, 'final');
          text = response.text;
        } finally { clearTimeout(timer); }
      }
      if (typeof text !== 'string' || !text.trim()) throw new Error('The model gave no final text.');
      task.text = text;
      task.state = task.verified || !options.verify && !options.verificationInstruction && !task.stopReason ? 'completed' : 'failed';
      await save(); await emit('final', { taskId: id, runId: id, text, state: task.state, stopReason: task.stopReason, verified: task.verified });
      return task;
    } catch (error) {
      if (error instanceof ConfirmationStop) return task;
      if (task) { task.state = externalSignal?.aborted ? 'cancelled' : 'failed'; task.error = error?.message || 'Task interrupted.'; await save(); }
      throw error;
    } finally {
      clearInterval(heartbeat); clearTimeout(deadline);
      await store.release(id, owner);
    }
  }
  return { store, create, resume, async run(input, execution) { const task = await create(input); return resume(task.id, execution); } };
}
module.exports = { createAgent };
