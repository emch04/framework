'use strict';

function estimateTokens(value) {
  return Math.ceil((typeof value === 'string' ? value : JSON.stringify(value ?? '')).length / 4);
}
function normalizeBudget(value = {}) {
  const out = { maxMs: 3600000, maxTurns: 1000, ...value };
  for (const key of ['maxMs', 'maxTurns', 'maxTokens', 'maxCost']) {
    if (out[key] !== undefined && (!Number.isFinite(out[key]) || out[key] < 0)) throw new Error(`${key} must be a finite non-negative number.`);
  }
  if (!Number.isInteger(out.maxTurns)) throw new Error('maxTurns must be an integer.');
  return out;
}
function usageOf(request, response, pricing = {}) {
  const raw = response?.usage || {};
  const input = raw.inputTokens ?? raw.prompt_tokens;
  const output = raw.outputTokens ?? raw.completion_tokens;
  const valid = (n) => Number.isFinite(n) && n >= 0;
  const inputTokens = valid(input) ? input : estimateTokens(request);
  const outputTokens = valid(output) ? output : estimateTokens(response);
  for (const price of Object.values(pricing)) if (!valid(price)) throw new Error('Prices must be finite non-negative numbers.');
  return { inputTokens, outputTokens, estimated: !valid(input) || !valid(output), cost: valid(raw.cost) ? raw.cost : (inputTokens * (pricing.inputPerMillion || 0) + outputTokens * (pricing.outputPerMillion || 0)) / 1000000 };
}
function budgetReason(task, budget) {
  if (task.elapsedMs >= budget.maxMs) return 'time';
  if (task.turns >= budget.maxTurns) return 'turns';
  if (budget.maxTokens !== undefined && task.usage.inputTokens + task.usage.outputTokens >= budget.maxTokens) return 'tokens';
  if (budget.maxCost !== undefined && task.usage.cost >= budget.maxCost) return 'cost';
  return null;
}
module.exports = { estimateTokens, normalizeBudget, usageOf, budgetReason };
