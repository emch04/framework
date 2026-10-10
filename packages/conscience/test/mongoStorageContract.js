'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
function mongoStorageContract(label, fresh, options = {}) {
  const suite = (name, fn) => test(`${label}: ${name}`, options, async () => {
    const stores = await fresh();
    try { await fn(stores); } finally { await stores.cleanup?.(); }
  });
  suite('record filters, equal timestamp ordering, replacement and scoped deletion', async ({ store }) => {
    const envelope = (id, extra = {}) => ({ organisationId: 'o', kind: 'decision', id, userId: null, agentId: 'a', decisionId: 'd', lessonId: 'l', eventAt: '2026-01-02', recordedAt: '2026-01-03', evidenceRefs: ['e'], data: { text: '$value' }, ...extra });
    for (const row of [envelope('1'), envelope('2', { userId: 'u', eventAt: null }), envelope('3', { decisionId: 'other', lessonId: 'other', eventAt: '2026-01-04' }), envelope('1', { organisationId: 'other' })]) await store.put(row);
    const ids = async (filter) => (await store.list('decision', { organisationId: 'o', ...filter })).map((r) => r.id);
    assert.deepEqual(await ids({}), ['1', '2', '3']);
    assert.deepEqual(await ids({ order: 'desc' }), ['3', '2', '1']);
    assert.deepEqual(await ids({ userId: null }), ['1', '3']);
    assert.deepEqual(await ids({ agentId: 'a', decisionId: 'd', lessonId: 'l' }), ['1', '2']);
    assert.deepEqual(await ids({ decisionId: 'd', decisionIds: ['other'] }), []);
    assert.deepEqual(await ids({ evidenceRef: 'e', eventFrom: '2026-01-02', eventTo: '2026-01-04' }), ['1']);
    assert.deepEqual(await ids({ recordedTo: '2026-01-02' }), []);
    assert.deepEqual(await ids({ limit: 1 }), ['1']);
    assert.equal(await store.get('prediction', 'o', '1'), null);
    assert.equal(await store.replace(envelope('missing')), null);
    await store.replace(envelope('1', { data: { changed: true } }));
    assert.deepEqual(await ids({}), ['1', '2', '3']);
    assert.equal((await store.get('decision', 'o', '1')).data.changed, true);
    assert.equal(await store.remove('decision', 'o', []), 0);
    assert.equal(await store.remove('decision', 'o', ['1', '1', 'missing']), 1);
    assert.equal((await store.get('decision', 'other', '1')).id, '1');
  });
  suite('proposal filters and guards preserve literal content', async ({ governorStore: store }) => {
    const p = { organisationId: 'o', id: 'p', status: 'pending_approval', createdAt: '2026-01-01', change: { text: '$data', nested: { $set: 'literal' } } };
    await store.putProposal(p);
    await store.putProposal({ ...p, id: 'q', createdAt: '2026-01-02', status: 'declined', decidedAt: '2026-01-05' });
    await store.putProposal({ ...p, organisationId: 'other' });
    assert.equal((await store.listProposals({ organisationId: 'o', since: '2026-01-04' }))[0].id, 'q');
    assert.deepEqual(await store.listProposals({ organisationId: 'o', status: 'declined', statuses: ['approved'] }), []);
    assert.equal(await store.transitionProposal('o', 'p', 'approved', { status: 'declined' }), null);
    assert.equal(await store.transitionProposal('other', 'missing', 'pending_approval', {}), null);
    const patched = await store.transitionProposal('o', 'p', 'pending_approval', { note: '$data', approvals: [{ id: 'h' }] }, { approvals: 0 });
    assert.equal(patched.note, '$data');
    assert.deepEqual(patched.change, p.change);
    assert.equal(await store.transitionProposal('o', 'p', 'pending_approval', {}, { approvals: 0 }), null);
  });
  suite('audit filters, global entries, ordering and unique ids', async ({ governorStore: store }) => {
    const e = { id: '1', organisationId: 'o', proposalId: 'p', action: 'stage', objectKind: 'routing', objectId: 'r', at: '2026-01-01' };
    await store.appendAudit(e);
    await store.appendAudit({ ...e, id: '2', at: '2026-01-02', action: 'deploy' });
    await store.appendAudit({ id: '3', organisationId: null, action: 'halt', at: '2026-01-03' });
    await assert.rejects(store.appendAudit(e), { code: 11000 });
    assert.deepEqual((await store.listAudit({})).map((r) => r.id), ['3', '2', '1']);
    assert.deepEqual((await store.listAudit({ organisationId: null })).map((r) => r.id), ['3']);
    assert.deepEqual((await store.listAudit({ organisationId: 'o', proposalId: 'p', actions: ['deploy'], since: '2026-01-02', objectKind: 'routing', objectId: 'r' })).map((r) => r.id), ['2']);
    assert.deepEqual(await store.listAudit({ organisationId: 'other' }), []);
    assert.equal((await store.listAudit({ limit: 1 }))[0].id, '3');
  });
  suite('version, finding and control identities are persistent and scoped', async ({ governorStore: store }) => {
    assert.equal(await store.getControl('missing'), null);
    await store.setControl('switch', { halted: true }); await store.setControl('switch', { halted: false });
    assert.deepEqual(await store.getControl('switch'), { halted: false });
    const v = { organisationId: 'o', kind: 'routing', id: 'r', versionId: 'v1', number: 1 };
    await store.putVersion({ ...v, versionId: 'v2', number: 2 }); await store.putVersion(v);
    assert.equal((await store.putVersion({ ...v, number: 9 })).created, false);
    assert.equal(await store.getVersion('other', 'routing', 'r', 'v1'), null);
    assert.deepEqual((await store.listVersions(v)).map((r) => r.number), [1, 2]);
    assert.equal((await store.listVersions({ ...v, limit: 1 })).length, 1);
    const f = { organisationId: 'o', id: 'f', receivedAt: '2026-01-02' };
    await store.putFinding(f); assert.equal((await store.putFinding({ ...f, receivedAt: '2026-01-10' })).record.receivedAt, f.receivedAt);
    assert.equal((await store.listFindings({ organisationId: 'o', since: f.receivedAt, until: f.receivedAt })).length, 1);
    assert.equal((await store.listFindings({ organisationId: 'o', since: '2026-01-03' })).length, 0);
    assert.equal((await store.listFindings({ organisationId: 'other' })).length, 0);
  });
}
module.exports = { mongoStorageContract };
