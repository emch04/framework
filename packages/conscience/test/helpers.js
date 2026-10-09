'use strict';
const { createGovernor } = require('../src/governor');
const { createConscience } = require('../src');

const policy = (extra = {}) => ({ version: 'test-1', budgets: { perCycle: 5, perAgent: 8, perOrganisation: 10, periodMs: 86400000 }, ...extra });

/** Manual clock: every call returns the current time; advance() moves it. */
function makeClock(start = Date.parse('2026-10-01T00:00:00.000Z')) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; return current; };
  return now;
}

/* Deterministic masker used by the tests: people and e-mail addresses. */
const mask = (text) => String(text)
  .replace(/Alice Martin|Bruno Diallo|Alice|Bruno|Martin|Diallo/g, '[PERSON]')
  .replace(/[^\s@]+@[^\s@]+/g, '[EMAIL]');

function makeConscience({ store, governorStore, clock = makeClock(), governorPolicy = policy(), ...options } = {}) {
  const governor = createGovernor(governorPolicy, { store: governorStore, now: clock });
  const conscience = createConscience({ governor, masker: mask, store, now: clock, ...options });
  return { governor, conscience, clock };
}

function decisionInput(overrides = {}) {
  return {
    organisationId: 'org-a', userId: 'user-1', agentId: 'agent-x',
    objective: 'Remind Alice Martin about the unpaid invoice',
    context: { at: '2026-10-01T08:00:00.000Z', summary: 'Invoice 42 is 10 days late; contact alice@example.com', data: { invoice: 42, owner: 'Alice Martin' } },
    action: { name: 'send_reminder', kind: 'write', input: { channel: 'email', to: 'alice@example.com' } },
    alternatives: ['wait', { name: 'call', reason: 'outside office hours' }],
    expectedOutcome: { description: 'Invoice paid within 7 days', metric: 'paid', target: true },
    horizon: '2026-10-08T08:00:00.000Z',
    confidence: 0.7,
    permissions: ['invoices:read', 'email:send'],
    versions: { model: 'model-2026-09', tools: { send_reminder: '1.2.0' }, instructions: 'reminders-v3' },
    inputSnapshotRef: 'snapshot://invoices/42@2026-10-01',
    tools: [{ name: 'send_reminder', version: '1.2.0', callId: 'call-1' }],
    ...overrides
  };
}

module.exports = { policy, makeClock, mask, makeConscience, decisionInput };
