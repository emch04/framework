'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommandConnector } = require('../src');
const { makeGovernance, proposalInput } = require('./helpers');

function setup({ rules, run, recheck } = {}) {
  const sent = [];
  const connector = createCommandConnector({ commands: {
    send_message: {
      fields: ['to', 'body'], sensitive: ['to'], tags: ['outbound'], recheck,
      run: run ?? (async (values, context) => { sent.push({ values, context }); return { count: 3 }; })
    }
  } });
  return { sent, ...makeGovernance({ connector, rules }) };
}
const command = (id = 'm1') => ({ connector: 'shop', resource: 'send_message', op: 'insert', values: { id, to: 'parent@example.com', body: 'Lundi à 9 h' } });
const input = (actions = [command()]) => proposalInput({ intent: { code: 'notify' }, actions });

test('une commande attend une validation, avec un aperçu exact et masqué ; rien ne part avant', async () => {
  const { governance, sent } = setup();
  const out = await governance.propose(input());
  assert.equal(out.status, 'awaiting_validation');
  const [row] = out.proposal.preview.rows;
  assert.equal(row.after.body, 'Lundi à 9 h');
  assert.ok(row.after.to.$masked, 'le destinataire est masqué');
  assert.equal(sent.length, 0);
});

test('validée, elle s\'exécute une seule fois, avec sa clé d\'idempotence, et ne se rejoue pas', async () => {
  const { governance, sent, validate } = setup();
  const { proposal } = await governance.propose(input());
  const validation = validate(proposal);
  const done = await governance.applyValidation(validation, { organisationId: 'org-a' });
  assert.equal(done.status, 'executed');
  assert.equal(done.result.rowsAffected, 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].values.to, 'parent@example.com');
  assert.equal(sent[0].context.idempotencyKey, 'm1');
  await governance.applyValidation(validation, { organisationId: 'org-a' });
  assert.equal(sent.length, 1);
});

test('refusée, elle ne part pas', async () => {
  const { governance, sent, validate } = setup();
  const { proposal } = await governance.propose(input());
  const out = await governance.applyValidation(validate(proposal, { decision: 'decline', approvals: [] }), { organisationId: 'org-a' });
  assert.equal(out.status, 'declined');
  assert.equal(sent.length, 0);
});

test('une seule commande par proposition', async () => {
  const { governance } = setup();
  await assert.rejects(governance.propose(input([command('m1'), command('m2')])), { code: 'too_many_actions' });
});

test('« libre avec avis » devient une validation, puisque rien ne se défait', async () => {
  const { governance, sent } = setup({ rules: [{ id: 'notice', level: 'free_with_notice', match: { tags: ['outbound'] } }] });
  const out = await governance.propose(input());
  assert.equal(out.status, 'awaiting_validation');
  assert.equal(out.level, 'validation');
  assert.equal(sent.length, 0);
});

test('un niveau « libre » s\'exécute tout de suite et ne s\'annule pas', async () => {
  const { governance, sent } = setup({ rules: [{ id: 'free', level: 'free', match: { tags: ['outbound'] } }] });
  const out = await governance.propose(input());
  assert.equal(out.status, 'executed');
  assert.equal(sent.length, 1);
  const undone = await governance.undo(out.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'user-7' } });
  assert.equal(undone.code, 'not_undoable');
  assert.equal(undone.status, 'executed');
});

test('« interdit » reste interdit', async () => {
  const { governance, sent } = setup({ rules: [{ id: 'no', level: 'forbidden', match: { tags: ['outbound'] } }] });
  const out = await governance.propose(input());
  assert.notEqual(out.status, 'executed');
  assert.equal(sent.length, 0);
});

test('la revérification arrête la commande au dernier moment', async () => {
  const { governance, sent, validate } = setup({ recheck: async () => 'recipient_blocked' });
  const { proposal } = await governance.propose(input());
  const out = await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
  assert.equal(out.status, 'stale');
  assert.equal(sent.length, 0);
});

test('une erreur de run donne « failed » et n\'est jamais relancée', async () => {
  let calls = 0;
  const { governance, validate } = setup({ run: async () => { calls += 1; throw new Error('smtp'); } });
  const { proposal } = await governance.propose(input());
  const validation = validate(proposal);
  const out = await governance.applyValidation(validation, { organisationId: 'org-a' });
  assert.equal(out.status, 'failed');
  await governance.applyValidation(validation, { organisationId: 'org-a' });
  assert.equal(calls, 1);
});

test('une commande sans run ou une déclaration vide est refusée', () => {
  assert.throws(() => createCommandConnector({ commands: {} }), { code: 'invalid_resources' });
  assert.throws(() => createCommandConnector({ commands: { send_message: { fields: ['to'] } } }), { code: 'invalid_resources' });
});
