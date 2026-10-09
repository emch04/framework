'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runReflection, AVAILABLE_FROM } = require('../src/autoconscience');
const { createGovernor } = require('../src/governor');
const { policy } = require('./helpers');

test('runReflection checks the governor first, then says it is not available before P2', async () => {
  await assert.rejects(runReflection(), { code: 'governor_missing' });
  await assert.rejects(runReflection({ governor: { assertReady: async () => true } }), { code: 'governor_invalid' });
  const governor = createGovernor(policy());
  await governor.halt({ by: { kind: 'human', id: 'admin' } });
  await assert.rejects(runReflection({ governor }), { code: 'governor_halted' });
  await governor.resume({ by: { kind: 'human', id: 'admin' } });
  await assert.rejects(runReflection({ governor, organisationId: 'org-a' }), (error) => error.code === 'not_available' && /P2/.test(error.message));
  assert.equal(AVAILABLE_FROM, 'P2');
});
