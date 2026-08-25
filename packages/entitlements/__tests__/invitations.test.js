const { createInvitations, createMemoryInvitationStore, InvitationError } = require('../src');

function build(overrides = {}) {
  const accounts = [];
  const delivered = [];
  const store = createMemoryInvitationStore();
  const invitations = createInvitations({
    store,
    roles: ['teacher', 'secretary', 'director'],
    createAccount: async (invitation, form) => {
      const account = { email: invitation.email || form.email, role: invitation.role, name: form.name };
      accounts.push(account);
      return account;
    },
    buildUrl: (token) => `https://app.acme.cd/register?token=${token}`,
    deliver: async ({ url, invitation }) => { delivered.push({ url, email: invitation.email }); },
    ...overrides
  });
  return { invitations, store, accounts, delivered };
}

describe('inviting', () => {
  test('an invitation carries a link and records who sent it', async () => {
    const { invitations, delivered } = build();

    const { invitation, token, url } = await invitations.invite({
      email: 'Marie@Ecole.cd', role: 'teacher', invitedBy: 'director-1'
    });

    expect(invitation).toMatchObject({ email: 'marie@ecole.cd', role: 'teacher', status: 'pending', invitedBy: 'director-1' });
    expect(url).toBe(`https://app.acme.cd/register?token=${token}`);
    expect(delivered).toEqual([{ url, email: 'marie@ecole.cd' }]);
  });

  test('the store NEVER holds the token — only its fingerprint', async () => {
    /* A leaked collection must not let anyone accept every pending
       invitation. */
    const { invitations, store } = build();

    const { token } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });

    const rows = await store.list();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a role outside the list is refused — roles are the product\'s to declare', async () => {
    const { invitations } = build();

    await expect(invitations.invite({ role: 'super_admin', invitedBy: 'd' }))
      .rejects.toBeInstanceOf(InvitationError);
  });

  test('an unsigned invitation is refused', async () => {
    const { invitations } = build();

    await expect(invitations.invite({ role: 'teacher' })).rejects.toThrow(/who sent it/);
  });

  test('a NEW invitation retires the old ones for the same address', async () => {
    /* The older link is exactly the kind of thing that resurfaces from an
       inbox months later. */
    const { invitations } = build();
    const first = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });
    await invitations.invite({ email: 'a@x.cd', role: 'secretary', invitedBy: 'd' });

    await expect(invitations.verify(first.token)).rejects.toThrow(/no longer valid/);
  });

  test('a failed delivery does NOT destroy the invitation — the link can be sent by hand', async () => {
    const { invitations } = build({ deliver: async () => { throw new Error('smtp down'); } });

    const { invitation, url } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });

    expect(invitation.status).toBe('pending');
    expect(url).toBeTruthy();
  });

  test('an invitation without an email works — a link shown on screen, a QR code', async () => {
    const { invitations, delivered } = build();

    const { invitation, token } = await invitations.invite({ role: 'teacher', invitedBy: 'd' });

    expect(invitation.email).toBeNull();
    expect(delivered).toHaveLength(0);
    expect((await invitations.verify(token)).role).toBe('teacher');
  });
});

describe('verifying', () => {
  test('a live token tells the registration page what to render', async () => {
    const { invitations } = build();
    const { token } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd', tenant: 's9' });

    expect(await invitations.verify(token)).toMatchObject({ email: 'a@x.cd', role: 'teacher', tenant: 's9' });
  });

  test('unknown and already-used answer with the SAME message', async () => {
    /* Which of the two it is, is information a token-probing attacker has no
       business getting. */
    const { invitations } = build();
    const { token } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });
    await invitations.accept(token, { name: 'Marie' });

    const unknown = await invitations.verify('jeton-invente').catch((e) => e.message);
    const used = await invitations.verify(token).catch((e) => e.message);

    expect(unknown).toBe(used);
  });

  test('an expired link says so, and the invitation is marked expired', async () => {
    let time = 1_000_000;
    const { invitations, store } = build({ now: () => time, ttlMs: 1000 });
    const { token, invitation } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });

    time += 1001;

    await expect(invitations.verify(token)).rejects.toThrow(/expired/);
    expect((await store.list())[0].status).toBe('expired');
    expect(invitation.status).toBe('pending');
  });
});

describe('accepting', () => {
  test('acceptance creates the account with the INVITATION\'s role, not the form\'s', async () => {
    const { invitations, accounts } = build();
    const { token } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });

    const { account, invitation } = await invitations.accept(token, { name: 'Marie', role: 'director' });

    expect(account).toMatchObject({ email: 'a@x.cd', role: 'teacher', name: 'Marie' });
    expect(invitation.status).toBe('used');
    expect(accounts).toHaveLength(1);
  });

  test('the same link twice creates ONE account', async () => {
    const { invitations, accounts } = build();
    const { token } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });

    await invitations.accept(token, { name: 'Marie' });
    await expect(invitations.accept(token, { name: 'Imposteur' })).rejects.toThrow(/no longer valid/);

    expect(accounts).toHaveLength(1);
  });

  test('two SIMULTANEOUS acceptances create one account, not two', async () => {
    const { invitations, accounts } = build();
    const { token } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });

    const outcomes = await Promise.allSettled([
      invitations.accept(token, { name: 'A' }),
      invitations.accept(token, { name: 'B' })
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(accounts).toHaveLength(1);
  });

  test('a failed account creation marks the invitation FAILED — never used', async () => {
    /* "Used" for an account that was never born strands the person: dead
       link, no account. */
    const { invitations, store } = build({
      createAccount: async () => { throw new Error('email already registered'); }
    });
    const { token } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });

    await expect(invitations.accept(token, {})).rejects.toThrow('email already registered');

    expect((await store.list())[0]).toMatchObject({ status: 'failed', failReason: 'email already registered' });
  });
});

describe('revoking and listing', () => {
  test('a revocation closes the link and records who closed it', async () => {
    const { invitations } = build();
    const { token, invitation } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });

    const revoked = await invitations.revoke(invitation.id, { revokedBy: 'director-1' });

    expect(revoked).toMatchObject({ status: 'revoked', revokedBy: 'director-1' });
    await expect(invitations.verify(token)).rejects.toThrow(/no longer valid/);
  });

  test('an already-handled invitation cannot be revoked — 409, not silence', async () => {
    const { invitations } = build();
    const { token, invitation } = await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });
    await invitations.accept(token, { name: 'Marie' });

    await expect(invitations.revoke(invitation.id, { revokedBy: 'd' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('list() filters — what an admin screen needs', async () => {
    const { invitations } = build();
    await invitations.invite({ email: 'a@x.cd', role: 'teacher', invitedBy: 'd' });
    const second = await invitations.invite({ email: 'b@x.cd', role: 'secretary', invitedBy: 'd' });
    await invitations.revoke(second.invitation.id, { revokedBy: 'd' });

    expect(await invitations.list({ status: 'pending' })).toHaveLength(1);
    expect(await invitations.list({ status: 'revoked' })).toHaveLength(1);
  });
});

describe('wiring', () => {
  test('a module without store, roles or account creation is refused up front', () => {
    const store = createMemoryInvitationStore();
    const createAccount = async () => ({});

    expect(() => createInvitations({ roles: ['x'], createAccount })).toThrow(/store/);
    expect(() => createInvitations({ store, roles: [], createAccount })).toThrow(/roles/);
    expect(() => createInvitations({ store, roles: ['x'] })).toThrow(/createAccount/);
  });
});
