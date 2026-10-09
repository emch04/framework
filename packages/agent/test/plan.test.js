'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan, createPlanTool, PLAN_STATES } = require('../src');
test('plans accept every state and reject malformed or duplicate steps', async () => {
  const plan = PLAN_STATES.map((state, i) => ({ id: String(i), text: 'Step', state }));
  assert.deepEqual(validatePlan(plan), plan);
  for (const invalid of [null, {}, [{ id: 'a', text: '', state: 'todo' }], [{ id: 'a', text: 'a', state: 'wrong' }], [plan[0], plan[0]]]) assert.throws(() => validatePlan(invalid));
  let saved; const tool = createPlanTool(async (steps) => { saved = steps; });
  assert.deepEqual((await tool.run({ steps: plan })).data.plan, saved);
  assert.notEqual(saved, plan);
});
