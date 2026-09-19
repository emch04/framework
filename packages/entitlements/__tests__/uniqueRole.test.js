const { createUniqueRole, createMemoryUniqueRoleStore, pickIntruders, UniqueRoleError } = require('../src');

const OWNER = { id: '1', email: 'owner@acme.test', role: 'owner' };
const INTRUDER = { id: '2', email: 'intruder@elsewhere.test', role: 'owner' };
const MEMBER = { id: '3', email: 'member@acme.test', role: 'member' };

function build(options = {}) {
  const store = options.store || createMemoryUniqueRoleStore(options.accounts || [OWNER, MEMBER]);
  const alerts = [];
  const guard = createUniqueRole({
    role: 'owner',
    anchor: 'owner@acme.test',
    store,
    alert: async (event) => { alerts.push(event); },
    ...options.guard
  });
  return { guard, store, alerts };
}

describe('the decision', () => {
  test('refuses a second holder, lets the first one in, ignores every other role', () => {
    const { guard } = build();
    expect(guard.verdict({ role: 'owner', otherHolderExists: true })).toMatchObject({ refused: true, reason: 'role_taken', statusCode: 409 });
    expect(guard.verdict({ role: 'owner', otherHolderExists: false }).refused).toBe(false);
    for (const role of ['member', 'admin', '', null, undefined]) {
      expect(guard.verdict({ role, otherHolderExists: true }).refused).toBe(false);
    }
  });

  test('case and spaces open no side door', () => {
    const { guard } = build();
    expect(guard.isRole(' OWNER ')).toBe(true);
    expect(guard.verdict({ role: ' Owner ', otherHolderExists: true }).refused).toBe(true);
  });

  test('the role name is a parameter, required', () => {
    expect(() => createUniqueRole({})).toThrow(/options.role/);
    const custom = createUniqueRole({ role: 'platform_root' });
    expect(custom.isRole('platform_root')).toBe(true);
    expect(custom.isRole('owner')).toBe(false);
  });
});

describe('creation', () => {
  test('a second holder cannot be created — and the attempt raises an alert', async () => {
    const { guard, alerts } = build();

    await expect(guard.assertCanCreate({ role: 'owner', actor: MEMBER, account: { email: 'new@x.test' } }))
      .rejects.toMatchObject({ reason: 'role_taken', statusCode: 409 });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'create_refused', role: 'owner', actor: MEMBER, holder: { id: '1' } });
  });

  test('"OWNER" in capitals is refused too', async () => {
    const { guard } = build();
    await expect(guard.assertCanCreate({ role: 'OWNER ' })).rejects.toBeInstanceOf(UniqueRoleError);
  });

  test('the first holder can be created while none exists', async () => {
    const { guard, alerts } = build({ accounts: [MEMBER] });
    await expect(guard.assertCanCreate({ role: 'owner' })).resolves.toBeUndefined();
    expect(alerts).toHaveLength(0);
  });

  test('allowBootstrap: false closes creation even on an empty platform', async () => {
    const { guard, alerts } = build({ accounts: [], guard: { allowBootstrap: false } });
    await expect(guard.assertCanCreate({ role: 'owner' })).rejects.toMatchObject({ reason: 'bootstrap_closed', statusCode: 403 });
    expect(alerts[0].kind).toBe('create_refused');
  });

  test('other roles never touch the store', async () => {
    const store = { findHolders: jest.fn(async () => [OWNER]) };
    const { guard } = build({ store });
    await guard.assertCanCreate({ role: 'member' });
    expect(store.findHolders).not.toHaveBeenCalled();
  });
});

describe('promotion and demotion', () => {
  test('nobody can be promoted to the role while a holder exists', async () => {
    const { guard, alerts } = build();

    await expect(guard.assertCanChangeRole({ account: MEMBER, nextRole: 'owner', actor: MEMBER }))
      .rejects.toMatchObject({ reason: 'role_taken' });
    expect(alerts[0]).toMatchObject({ kind: 'promotion_refused', account: MEMBER });
  });

  test('an account passed with the role ALREADY applied is still checked against the store', async () => {
    /* The save hook of an ORM sees the document after the change: trusting
       its role to mean "already the holder" would wave every promotion through. */
    const { guard } = build();
    await expect(guard.assertCanChangeRole({ account: { ...MEMBER, role: 'owner' }, nextRole: 'owner' }))
      .rejects.toMatchObject({ reason: 'role_taken' });
  });

  test('the holder saving their own account does not collide with themselves', async () => {
    const { guard, alerts } = build();
    await expect(guard.assertCanChangeRole({ account: OWNER, nextRole: 'owner', actor: OWNER })).resolves.toBeUndefined();
    expect(alerts).toHaveLength(0);
  });

  test('the holder cannot be demoted: the platform would be left without a top', async () => {
    const { guard, alerts } = build();
    await expect(guard.assertCanChangeRole({ account: OWNER, nextRole: 'member', actor: MEMBER }))
      .rejects.toMatchObject({ reason: 'last_holder' });
    expect(alerts[0].kind).toBe('demotion_refused');
  });

  test('a regular role change passes silently', async () => {
    const { guard, alerts } = build();
    await expect(guard.assertCanChangeRole({ account: MEMBER, nextRole: 'admin' })).resolves.toBeUndefined();
    expect(alerts).toHaveLength(0);
  });
});

describe('renaming', () => {
  test("nobody else can take the holder's identifier", async () => {
    /* The sweep keeps the account carrying the anchor: an account renamed
       onto it would be kept, and the real holder removed. */
    const { guard, alerts } = build();
    await expect(guard.assertCanRename({ account: MEMBER, nextIdentifier: ' Owner@ACME.test ', actor: MEMBER }))
      .rejects.toMatchObject({ reason: 'identity_taken', statusCode: 409 });
    expect(alerts[0]).toMatchObject({ kind: 'rename_refused', account: MEMBER });
  });

  test('claiming the role in the account object does not make one the holder', async () => {
    const { guard } = build();
    await expect(guard.assertCanRename({ account: { ...MEMBER, role: 'owner' }, nextIdentifier: 'owner@acme.test' }))
      .rejects.toMatchObject({ reason: 'identity_taken' });
  });

  test('any other new identifier is free', async () => {
    const { guard } = build();
    await expect(guard.assertCanRename({ account: MEMBER, nextIdentifier: 'new@acme.test' })).resolves.toBeUndefined();
  });

  test('the holder moving onto a newly configured anchor is allowed', async () => {
    const { guard } = build({ guard: { anchor: () => 'owner-new@acme.test' } });
    await expect(guard.assertCanRename({ account: OWNER, nextIdentifier: 'owner-new@acme.test' })).resolves.toBeUndefined();
  });
});

describe("the holder's account", () => {
  test('nobody else modifies or deletes it', async () => {
    const { guard, alerts } = build();
    await expect(guard.assertCanModify({ target: OWNER, actor: MEMBER })).rejects.toMatchObject({ reason: 'holder_protected', statusCode: 403 });
    expect(alerts[0]).toMatchObject({ kind: 'modify_refused', actor: MEMBER, account: OWNER });
  });

  test('the holder edits their own; others edit other accounts freely', async () => {
    const { guard } = build();
    await expect(guard.assertCanModify({ target: OWNER, actor: OWNER })).resolves.toBeUndefined();
    await expect(guard.assertCanModify({ target: MEMBER, actor: MEMBER })).resolves.toBeUndefined();
  });
});

describe('the alert and its texts are parameters', () => {
  test('refusal messages come from the caller; without one, only the reason code', async () => {
    const withText = build({ guard: { messages: { role_taken: 'Il ne peut y en avoir qu’un.' } } }).guard;
    await expect(withText.assertCanCreate({ role: 'owner' })).rejects.toThrow('Il ne peut y en avoir qu’un.');
    await expect(build().guard.assertCanCreate({ role: 'owner' })).rejects.toThrow(/^role_taken$/);
  });

  test('a failing alert neither lets the attempt through nor hides the refusal', async () => {
    const logger = { error: jest.fn() };
    const { guard } = build({ guard: { alert: async () => { throw new Error('smtp down'); }, logger } });
    await expect(guard.assertCanCreate({ role: 'owner' })).rejects.toMatchObject({ reason: 'role_taken' });
    expect(logger.error).toHaveBeenCalled();
  });
});

/* ── The sentinel ─────────────────────────────────────────────────────────
   Direct writes (a database shell, a restored backup) never meet the checks
   above. The sweep finds what came in anyway. IT DELETES ACCOUNTS: the tests
   start with the cases where it must do NOTHING. */

describe('the sentinel does NOTHING when in doubt', () => {
  test('no anchor: nobody is known to be legitimate', () => {
    expect(pickIntruders({ accounts: [OWNER, INTRUDER], anchor: undefined })).toMatchObject({ intruders: [], reason: 'anchor_missing' });
  });

  test('several holders and none carries the anchor: touch nothing', () => {
    expect(pickIntruders({ accounts: [INTRUDER, { id: '9', email: 'x@y.test' }], anchor: 'owner@acme.test' }))
      .toMatchObject({ intruders: [], reason: 'anchor_not_found' });
  });

  test('a single holder is never removed, even unanchored', () => {
    expect(pickIntruders({ accounts: [INTRUDER], anchor: 'owner@acme.test' })).toMatchObject({ intruders: [], reason: 'anchor_mismatch' });
    expect(pickIntruders({ accounts: [OWNER], anchor: 'owner@acme.test' })).toMatchObject({ intruders: [], reason: 'single' });
    expect(pickIntruders({ accounts: [], anchor: 'owner@acme.test' })).toMatchObject({ intruders: [], reason: 'none' });
  });
});

describe('the sentinel removes the intruders, and them only', () => {
  test('keeps the anchored account whatever the order, case or spacing', () => {
    const verdict = pickIntruders({
      accounts: [INTRUDER, { ...OWNER, email: '  Owner@ACME.test ' }, { id: '4', email: 'other@x.test' }],
      anchor: ' OWNER@acme.test '
    });
    expect(verdict.holder.id).toBe('1');
    expect(verdict.intruders.map((a) => a.id)).toEqual(['2', '4']);
  });

  test('removes the intruder, keeps the holder, and alerts naming what was removed', async () => {
    const { guard, store, alerts } = build({ accounts: [OWNER, INTRUDER, MEMBER] });

    const outcome = await guard.sweep();

    expect(outcome.removed.map((a) => a.id)).toEqual(['2']);
    expect(store.list().map((a) => a.id).sort()).toEqual(['1', '3']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'intruders_removed', holder: { id: '1' }, intruders: [{ id: '2' }] });
  });

  test('a holder written in capitals by hand is still found', async () => {
    const { guard, store } = build({ accounts: [OWNER, { ...INTRUDER, role: ' OWNER' }] });
    await guard.sweep();
    expect(store.size()).toBe(1);
  });

  test('dry run: says what it would remove, removes and sends nothing', async () => {
    const { guard, store, alerts } = build({ accounts: [OWNER, INTRUDER] });
    const outcome = await guard.sweep({ dryRun: true });
    expect(outcome.removed.map((a) => a.id)).toEqual(['2']);
    expect(store.size()).toBe(2);
    expect(alerts).toHaveLength(0);
  });

  test('a failing alert does not keep the intruder in place', async () => {
    const { guard, store } = build({ accounts: [OWNER, INTRUDER], guard: { alert: async () => { throw new Error('smtp down'); } } });
    await expect(guard.sweep()).resolves.toBeDefined();
    expect(store.size()).toBe(1);
  });

  test('an account that changed rank since the read is not deleted', async () => {
    const inner = createMemoryUniqueRoleStore([OWNER, INTRUDER]);
    const store = {
      ...inner,
      async findHolders(role) {
        const found = await inner.findHolders(role);
        inner.update('2', { role: 'member' }); // demoted between read and write
        return found;
      }
    };
    const { guard } = build({ store });
    const outcome = await guard.sweep();
    expect(outcome.removed).toEqual([]);
    expect(inner.size()).toBe(2);
  });

  test('a healthy platform raises nothing', async () => {
    const { guard, alerts } = build();
    const outcome = await guard.sweep();
    expect(outcome.removed).toEqual([]);
    expect(alerts).toHaveLength(0);
  });

  test('a single holder that is NOT the anchored one is reported — it is what a replaced holder looks like', async () => {
    const { guard, store, alerts } = build({ accounts: [INTRUDER, MEMBER] });
    await guard.sweep();
    expect(store.size()).toBe(2);
    expect(alerts).toEqual([expect.objectContaining({ kind: 'anchor_mismatch' })]);
  });

  test('several holders without an anchor: nothing removed, an alert asks for a human', async () => {
    const { guard, store, alerts } = build({ accounts: [OWNER, INTRUDER], guard: { anchor: undefined } });
    await guard.sweep();
    expect(store.size()).toBe(2);
    expect(alerts[0].kind).toBe('anchor_missing');
  });
});
