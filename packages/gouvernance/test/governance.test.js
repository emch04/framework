'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryGovernorStore } = require('@astratra/conscience/governor');
const { digestOf } = require('../src');
const { makeGovernance, proposalInput, makePasskey } = require('./helpers');

const price = (shop, id) => shop.snapshot('products').find((p) => p.id === id).price;
const FREE_READS = [{ id: 'catalogue-free', level: 'free', match: { resources: ['products'], ops: ['update'] } }];

test('sans règle, une écriture attend une validation ; l\'aperçu est exact et rien n\'est écrit', async () => {
  const { governance, shop } = makeGovernance();
  const out = await governance.propose(proposalInput());
  assert.equal(out.status, 'awaiting_validation');
  assert.equal(out.level, 'validation');
  assert.deepEqual(out.proposal.preview.rows.map((r) => [r.key.id, r.before.price, r.after.price]), [['p1', 1000, 1050], ['p3', 2000, 2100]]);
  assert.equal(out.proposal.preview.amount, 150);
  assert.equal(out.proposal.classification.rules[0].origin, 'default');
  assert.equal(price(shop, 'p1'), 1000);
});

test('validation signée : revérifie, exécute tout ou rien, audite, puis ne se rejoue pas', async () => {
  const { governance, shop, validate, governorStore } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  const validation = validate(proposal);
  const done = await governance.applyValidation(validation, { organisationId: 'org-a' });
  assert.equal(done.status, 'executed');
  assert.equal(done.result.rowsAffected, 2);
  assert.equal(price(shop, 'p1'), 1050);
  assert.equal(price(shop, 'p3'), 2100);
  assert.equal(price(shop, 'p2'), 3000, 'la ligne en promotion ne bouge pas');
  const again = await governance.applyValidation(validation, { organisationId: 'org-a' });
  assert.equal(again.code, 'replayed');
  assert.equal(price(shop, 'p1'), 1050);
  const journal = await governorStore.listAudit({ organisationId: 'org-a' });
  const actions = journal.map((e) => `${e.action}:${e.decision}`);
  for (const step of ['data_proposal:awaiting_validation', 'data_decision:approved', 'data_execution:allowed', 'data_outcome:executed']) assert.ok(actions.includes(step), step);
  assert.ok(!JSON.stringify(journal).includes('1050'), 'le journal ne garde aucune valeur');
});

test('une donnée changée entre la validation et l\'écriture arrête tout', async () => {
  const { governance, shop, validate } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  shop.mutate('products', (rows) => { rows.find((p) => p.id === 'p3').price = 2500; });
  const out = await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
  assert.equal(out.status, 'stale');
  assert.equal(out.code, 'stale_data');
  assert.equal(out.result.detail.reason, 'changed');
  assert.equal(price(shop, 'p1'), 1000, 'tout ou rien : p1 non plus');
  assert.equal(price(shop, 'p3'), 2500);
});

test('une ligne apparue depuis l\'aperçu (fantôme) arrête tout', async () => {
  const { governance, shop, validate } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  shop.mutate('products', (rows) => rows.push({ id: 'p9', label: 'Bol', price: 800, stock: 3, promo: false, category: 'kitchen' }));
  const out = await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
  assert.equal(out.code, 'stale_data');
  assert.equal(out.result.detail.reason, 'appeared');
  assert.equal(price(shop, 'p1'), 1000);
});

test('une ligne supprimée depuis l\'aperçu arrête tout', async () => {
  const { governance, shop, validate } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  shop.mutate('products', (rows) => rows.splice(rows.findIndex((p) => p.id === 'p3'), 1));
  const out = await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
  assert.equal(out.code, 'stale_data');
  assert.equal(out.result.detail.reason, 'missing');
});

test('libre : exécuté tout de suite et tracé ; libre avec avis : annulable par un humain seulement', async () => {
  const free = makeGovernance({ rules: FREE_READS });
  const out = await free.governance.propose(proposalInput());
  assert.equal(out.status, 'executed');
  assert.equal(price(free.shop, 'p1'), 1050);

  const notice = makeGovernance({ rules: [{ id: 'notice', level: 'free_with_notice', match: { resources: ['products'] } }] });
  const done = await notice.governance.propose(proposalInput());
  assert.equal(done.status, 'executed');
  await assert.rejects(notice.governance.undo(done.proposal.id, { organisationId: 'org-a', by: { kind: 'model', id: 'assistant' } }), { code: 'approver_not_human' });
  const undone = await notice.governance.undo(done.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'user-7' } });
  assert.equal(undone.status, 'undone');
  assert.equal(price(notice.shop, 'p1'), 1000);
  assert.equal(price(notice.shop, 'p3'), 2000);
});

test('annuler s\'arrête si la ligne a encore changé, et se ferme après le délai', async () => {
  const { governance, shop, clock } = makeGovernance({ rules: [{ id: 'notice', level: 'free_with_notice', match: { resources: ['products'] } }] });
  const done = await governance.propose(proposalInput());
  shop.mutate('products', (rows) => { rows.find((p) => p.id === 'p1').price = 1111; });
  const stale = await governance.undo(done.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'user-7' } });
  assert.equal(stale.code, 'stale_data');
  assert.equal(stale.status, 'executed');
  assert.equal(price(shop, 'p3'), 2100, 'tout ou rien aussi pour l\'annulation');
  clock.advance(25 * 3600_000);
  const late = await governance.undo(done.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'user-7' } });
  assert.equal(late.code, 'undo_window_closed');
});

test('une suppression n\'est jamais « libre avec avis » : elle passe en validation', async () => {
  const { governance } = makeGovernance({ rules: [{ id: 'notice', level: 'free_with_notice', match: { resources: ['products'] } }] });
  const out = await governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'delete', where: { id: 'p4' } }] }));
  assert.equal(out.status, 'awaiting_validation');
  assert.ok(out.reasons.includes('not_undoable'));
});

test('interdit : refusé, même avec une validation valide', async () => {
  const { governance, validate, shop } = makeGovernance({ rules: [{ id: 'no-delete', level: 'forbidden', match: { ops: ['delete'] } }] });
  const out = await governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'delete', where: { id: 'p4' } }] }));
  assert.equal(out.status, 'refused');
  assert.ok(out.reasons.includes('forbidden'));
  const tried = await governance.applyValidation(validate(out.proposal), { organisationId: 'org-a' });
  assert.equal(tried.code, 'already_handled');
  assert.equal(shop.snapshot('products').length, 4);
});

test('une règle devenue « interdit » après la validation bloque l\'exécution', async () => {
  let remote = [];
  const { governance, validate, shop } = makeGovernance({ remoteRules: async () => ({ version: 1, rules: remote }) });
  const { proposal } = await governance.propose(proposalInput());
  remote = [{ id: 'freeze', level: 'forbidden', match: { resources: ['products'] } }];
  const out = await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
  assert.equal(out.code, 'forbidden');
  assert.equal(price(shop, 'p1'), 1000);
});

test('les règles distantes resserrent mais n\'assouplissent jamais une règle locale', async () => {
  const { governance } = makeGovernance({
    rules: [{ id: 'local', level: 'validation', match: { resources: ['products'] } }],
    remoteRules: async () => ({ version: 3, rules: [{ id: 'remote', level: 'free', match: { resources: ['products'] } }] })
  });
  const out = await governance.propose(proposalInput());
  assert.equal(out.level, 'validation');
});

test('règles distantes jamais lues : tout ce qui écrit attend une validation ; ensuite, le dernier réglage connu', async () => {
  let up = false;
  const { governance } = makeGovernance({
    remoteRules: async () => { if (!up) throw new Error('muette'); return { version: 1, rules: FREE_READS }; }
  });
  const first = await governance.propose(proposalInput());
  assert.equal(first.level, 'validation');
  assert.ok(first.reasons.includes('remote_rules_unavailable'));
  up = true;
  assert.equal((await governance.propose(proposalInput())).status, 'executed');
  up = false;
  assert.equal((await governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { id: 'p4' }, set: { stock: 2 } }] }))).status, 'executed');
});

test('quotas : au-delà de N actions libres par jour, retour en validation', async () => {
  const { governance, clock } = makeGovernance({ rules: [{ id: 'free', level: 'free', match: { resources: ['products'] }, quota: { perDay: 2 } }] });
  const one = (id) => governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { id }, set: { stock: { increment: 1 } } }] }));
  assert.equal((await one('p1')).status, 'executed');
  assert.equal((await one('p2')).status, 'executed');
  const third = await one('p3');
  assert.equal(third.status, 'awaiting_validation');
  assert.ok(third.reasons.includes('quota_exceeded'));
  clock.advance(24 * 3600_000);
  assert.equal((await one('p3')).status, 'executed', 'un nouveau jour, un nouveau quota');
});

test('quota global par IA (quotas.perDay)', async () => {
  const { governance } = makeGovernance({ rules: FREE_READS, quotas: { perDay: 1, timeZone: 'Europe/Paris' } });
  const one = (id) => governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { id }, set: { stock: 0 } }] }));
  assert.equal((await one('p1')).status, 'executed');
  assert.equal((await one('p2')).status, 'awaiting_validation');
});

test('arrêt d\'urgence : aucune proposition, aucune exécution ; la reprise exige un humain', async () => {
  const { governance, governor, validate, shop } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  await governor.halt({ by: { kind: 'model', id: 'assistant' }, reason: 'test', organisationId: 'org-a' });
  assert.equal((await governance.propose(proposalInput())).reasons[0], 'governor_halted');
  const validation = validate(proposal);
  const blocked = await governance.applyValidation(validation, { organisationId: 'org-a' });
  assert.equal(blocked.code, 'governor_halted');
  assert.equal(blocked.status, 'awaiting_validation', 'la validation n\'est pas consommée');
  assert.equal(price(shop, 'p1'), 1000);
  await governor.resume({ by: { kind: 'human', id: 'owner' }, organisationId: 'org-a' });
  assert.equal((await governance.applyValidation(validation, { organisationId: 'org-a' })).status, 'executed');
});

test('journal illisible : rien n\'est proposé ni exécuté', async () => {
  const broken = { ...createMemoryGovernorStore(), appendAudit: async () => { throw new Error('disque plein'); } };
  const { governance, shop } = makeGovernance({ auditStore: broken, rules: FREE_READS });
  await assert.rejects(governance.propose(proposalInput()), { code: 'audit_unavailable' });
  assert.equal(price(shop, 'p1'), 1000);
});

test('deux approbations exigées : une seule ne suffit pas', async () => {
  const { governance, validate, people } = makeGovernance({ approvers: 2, rules: [{ id: 'two', level: 'validation', approvals: 2, match: { resources: ['products'] } }] });
  const { proposal } = await governance.propose(proposalInput());
  assert.equal(proposal.classification.approvals, 2);
  assert.equal((await governance.applyValidation(validate(proposal, { approvals: [people[0]] }), { organisationId: 'org-a' })).code, 'not_enough_approvals');
  assert.equal((await governance.applyValidation(validate(proposal), { organisationId: 'org-a' })).status, 'executed');
});

test('refus signé : la proposition est refusée et ne s\'exécutera plus', async () => {
  const { governance, validate, shop } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  const declined = await governance.applyValidation(validate(proposal, { decision: 'decline', approvals: [] }), { organisationId: 'org-a' });
  assert.equal(declined.status, 'declined');
  assert.equal((await governance.applyValidation(validate(proposal), { organisationId: 'org-a' })).code, 'already_handled');
  assert.equal(price(shop, 'p1'), 1000);
});

test('annulation signée par le service de validation (décision « undo »)', async () => {
  const { governance, validate, shop } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
  const undone = await governance.applyValidation(validate(proposal, { decision: 'undo' }), { organisationId: 'org-a' });
  assert.equal(undone.status, 'undone');
  assert.equal(price(shop, 'p1'), 1000);
});

test('une proposition expire au bout de 12 heures', async () => {
  const { governance, validate, clock } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  clock.advance(13 * 3600_000);
  assert.equal((await governance.applyValidation(validate(proposal), { organisationId: 'org-a' })).code, 'expired');
  const other = await governance.propose(proposalInput());
  clock.advance(13 * 3600_000);
  assert.deepEqual(await governance.expire({ organisationId: 'org-a' }), [other.proposal.id]);
});

test('valeurs sensibles masquées dans la proposition ; l\'empreinte se recalcule sur ce qui est envoyé', async () => {
  const { governance } = makeGovernance();
  const out = await governance.propose(proposalInput({ intent: { code: 'fix_email' }, actions: [{ connector: 'shop', resource: 'customers', op: 'update', where: { id: 'c1' }, set: { email: 'deux@example.com' } }] }));
  const text = JSON.stringify(out.proposal);
  assert.ok(!text.includes('un@example.com'));
  assert.ok(out.proposal.preview.rows[0].before.email.$masked);
  assert.ok(text.includes('deux@example.com'), 'la nouvelle valeur demandée par l\'IA reste dans l\'action');
  const { digest, ...body } = out.proposal;
  assert.equal(digest, digestOf(body));
  assert.ok(governance.verifyDigest(out.proposal));
  assert.ok(!text.includes('Hausse'), 'l\'explication de l\'IA est hors de la proposition signée');
});

test('idempotence : la même clé rend la même proposition, sans nouvel aperçu', async () => {
  const { governance, shop } = makeGovernance();
  const a = await governance.propose(proposalInput({ idempotencyKey: 'demande-1' }));
  shop.mutate('products', (rows) => { rows[0].price = 999; });
  const b = await governance.propose(proposalInput({ idempotencyKey: 'demande-1' }));
  assert.equal(a.proposal.id, b.proposal.id);
  assert.equal(a.proposal.digest, b.proposal.digest);
});

test('refus avant l\'aperçu : colonne non modifiable, filtre absent, ligne en double, trop de lignes, aucune ligne', async () => {
  const { governance } = makeGovernance();
  const bad = (actions) => governance.propose(proposalInput({ actions }));
  await assert.rejects(bad([{ connector: 'shop', resource: 'products', op: 'update', where: { id: 'p1' }, set: { promo: true } }]), { code: 'column_not_writable' });
  await assert.rejects(bad([{ connector: 'shop', resource: 'products', op: 'update', where: {}, set: { stock: 1 } }]), { code: 'invalid_action' });
  await assert.rejects(bad([{ connector: 'shop', resource: 'products', op: 'update', where: '1=1', set: { stock: 1 } }]), { code: 'invalid_action' });
  await assert.rejects(bad([{ connector: 'shop', resource: 'products', op: 'update', where: { label: 'Tasse' }, set: { stock: 1 } }]), { code: 'column_not_filterable' });
  await assert.rejects(bad([
    { connector: 'shop', resource: 'products', op: 'update', where: { id: 'p1' }, set: { stock: 1 } },
    { connector: 'shop', resource: 'products', op: 'update', where: { category: 'kitchen' }, set: { stock: 2 } }
  ]), { code: 'overlapping_actions' });
  await assert.rejects(bad([{ connector: 'shop', resource: 'products', op: 'update', where: { id: 'zz' }, set: { stock: 1 } }]), { code: 'no_rows' });
  await assert.rejects(bad([{ connector: 'shop', resource: 'products', op: 'insert', values: { id: 'p1', label: 'X', price: 1 } }]), { code: 'row_exists' });
  await assert.rejects(bad([{ connector: 'other', resource: 'products', op: 'update', where: { id: 'p1' }, set: { stock: 1 } }]), { code: 'unknown_connector' });
  await assert.rejects(bad([{ connector: 'shop', resource: 'customers', op: 'delete', where: { id: 'c1' } }]), { code: 'operation_not_allowed' });
});

test('découper une grosse modification ne fait pas passer sous un seuil de lignes', async () => {
  const { governance } = makeGovernance({ rules: [
    { id: 'small', level: 'free', match: { resources: ['products'] } },
    { id: 'big', level: 'validation', match: { resources: ['products'], rowsAbove: 2 } }
  ] });
  const out = await governance.propose(proposalInput({ actions: ['p1', 'p2', 'p3'].map((id) => ({ connector: 'shop', resource: 'products', op: 'update', where: { id }, set: { stock: 0 } })) }));
  assert.equal(out.level, 'validation');
});

test('ajout puis annulation d\'un ajout', async () => {
  const { governance, validate, shop } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput({ intent: { code: 'add_product' }, actions: [{ connector: 'shop', resource: 'products', op: 'insert', values: { id: 'p5', label: 'Vase', price: 1500, stock: 4 } }] }));
  assert.equal(proposal.preview.rows[0].before, null);
  assert.equal((await governance.applyValidation(validate(proposal), { organisationId: 'org-a' })).status, 'executed');
  assert.equal(shop.snapshot('products').length, 5);
  assert.equal((await governance.undo(proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'owner' } })).status, 'undone');
  assert.equal(shop.snapshot('products').length, 4);
});

test('une organisation ne lit ni ne valide la proposition d\'une autre', async () => {
  const { governance, validate } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  assert.equal(await governance.get(proposal.id, { organisationId: 'org-b' }), null);
  assert.equal((await governance.applyValidation(validate(proposal), { organisationId: 'org-b' })).code, 'not_found');
});

test('une passkey inconnue de l\'application est refusée', async () => {
  const { governance, validate } = makeGovernance();
  const { proposal } = await governance.propose(proposalInput());
  const out = await governance.applyValidation(validate(proposal, { approvals: [{ approver: 'approver-1', passkey: makePasskey() }] }), { organisationId: 'org-a' });
  assert.equal(out.code, 'not_an_approver');
  assert.equal(out.status, 'awaiting_validation');
});
