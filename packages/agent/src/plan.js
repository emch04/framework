'use strict';
const PLAN_STATES = Object.freeze(['todo', 'in_progress', 'done', 'abandoned']);
function validatePlan(steps) {
  if (!Array.isArray(steps)) throw new Error('Plan must be an array.');
  const ids = new Set();
  return steps.map((step) => {
    if (!step || typeof step.id !== 'string' || !step.id || ids.has(step.id) || typeof step.text !== 'string' || !step.text.trim() || !PLAN_STATES.includes(step.state)) throw new Error('Invalid plan step.');
    ids.add(step.id);
    return { id: step.id, text: step.text, state: step.state };
  });
}
function createPlanTool(update) {
  return {
    name: 'update_plan', description: 'Replace the task plan with the current steps and their states.', kind: 'read',
    parameters: { type: 'object', required: ['steps'], properties: { steps: { type: 'array', items: { type: 'object', required: ['id', 'text', 'state'], properties: { id: { type: 'string' }, text: { type: 'string' }, state: { type: 'string', enum: PLAN_STATES } } } } } },
    async run(args) { const plan = validatePlan(args.steps); await update(plan); return { data: { plan } }; }
  };
}
module.exports = { PLAN_STATES, validatePlan, createPlanTool };
