const { URGENT_HOURS, createInvitationBoard } = require('../src');

const NOW = new Date('2026-08-26T10:00:00.000Z');
const board = createInvitationBoard();

const invite = (over = {}) => ({
  _id: 'inv-1',
  email: 'jean@example.test',
  role: 'seller',
  status: 'pending',
  expiresAt: '2026-08-27T10:00:00.000Z',
  ...over
});

describe('reading what the server sent', () => {
  test('an invitation without an id is not an invitation', () => {
    expect(board.read({ email: 'a@b.c' })).toBeNull();
    expect(board.read(null)).toBeNull();
    expect(board.read('nope')).toBeNull();
  });

  test('both id spellings are accepted', () => {
    expect(board.read({ _id: 'a' }).id).toBe('a');
    expect(board.read({ id: 'b' }).id).toBe('b');
  });

  test('an unknown status reads as pending rather than breaking the screen', () => {
    expect(board.read(invite({ status: 'martian' })).status).toBe('pending');
    expect(board.read(invite({ status: 'USED' })).status).toBe('used');
  });

  test('a list is found bare or wrapped, and unreadable rows are dropped', () => {
    expect(board.readMany([invite(), { email: 'no-id' }])).toHaveLength(1);
    expect(board.readMany({ invitations: [invite()] })).toHaveLength(1);
    expect(board.readMany(null)).toEqual([]);
  });
});

describe('effectiveStatus — the rule that matters', () => {
  test('A PENDING INVITATION PAST ITS DATE IS EXPIRED, whatever the server says', () => {
    const stale = board.read(invite({ expiresAt: '2026-08-26T09:00:00.000Z' }));

    expect(stale.status).toBe('pending');
    expect(board.effectiveStatus(stale, NOW)).toBe('expired');
  });

  test('a revoked invitation stays revoked — it must not read as actionable', () => {
    const revoked = board.read(invite({ status: 'revoked' }));

    expect(revoked.status).toBe('revoked');
    expect(board.effectiveStatus(revoked, NOW)).toBe('revoked');
    expect(board.tone(revoked, NOW)).toBe('neutral');
  });

  test('a revoked invitation belongs with the closed ones', () => {
    const revoked = board.read(invite({ status: 'revoked' }));

    expect(board.filter([revoked], 'closed', NOW)).toHaveLength(1);
    expect(board.counts([revoked], NOW)).toEqual({ total: 1, pending: 0, accepted: 0 });
  });

  test('a settled status is never recomputed', () => {
    const used = board.read(invite({ status: 'used', expiresAt: '2020-01-01T00:00:00.000Z' }));

    expect(board.effectiveStatus(used, NOW)).toBe('used');
  });

  test('no date, or an unreadable one, stays pending', () => {
    expect(board.effectiveStatus(board.read(invite({ expiresAt: null })), NOW)).toBe('pending');
    expect(board.effectiveStatus(board.read(invite({ expiresAt: 'soon' })), NOW)).toBe('pending');
  });
});

describe('hoursLeft and tone', () => {
  test('rounds up, so "1 hour left" never reads as zero', () => {
    const soon = board.read(invite({ expiresAt: '2026-08-26T10:30:00.000Z' }));

    expect(board.hoursLeft(soon, NOW)).toBe(1);
  });

  test('the question does not arise for a settled invitation', () => {
    expect(board.hoursLeft(board.read(invite({ status: 'used' })), NOW)).toBeNull();
  });

  test('a link about to die is worth chasing — that is what warning means', () => {
    const urgent = board.read(invite({ expiresAt: '2026-08-26T14:00:00.000Z' }));
    const calm = board.read(invite({ expiresAt: '2026-08-28T10:00:00.000Z' }));

    expect(board.tone(urgent, NOW)).toBe('warning');
    expect(board.tone(calm, NOW)).toBe('neutral');
    expect(board.tone(board.read(invite({ status: 'used' })), NOW)).toBe('success');
    expect(board.tone(board.read(invite({ status: 'failed' })), NOW)).toBe('danger');
  });

  test('the urgency threshold can be moved', () => {
    const patient = createInvitationBoard({ urgentHours: 1 });
    const urgent = patient.read(invite({ expiresAt: '2026-08-26T14:00:00.000Z' }));

    expect(URGENT_HOURS).toBe(6);
    expect(patient.tone(urgent, NOW)).toBe('neutral');
  });
});

describe('the three tabs', () => {
  const invitations = [
    invite({ _id: 'a' }),
    invite({ _id: 'b', status: 'used' }),
    invite({ _id: 'c', expiresAt: '2026-08-25T10:00:00.000Z' }),
    invite({ _id: 'd', status: 'failed' })
  ].map((raw) => board.read(raw));

  test('counts say where the recruitment stands without reading the list', () => {
    expect(board.counts(invitations, NOW)).toEqual({ total: 4, pending: 1, accepted: 1 });
  });

  test('CLOSED GATHERS EXPIRED AND FAILED — both are dead, both need a new one', () => {
    expect(board.filter(invitations, 'closed', NOW).map((i) => i.id)).toEqual(['c', 'd']);
    expect(board.filter(invitations, 'pending', NOW).map((i) => i.id)).toEqual(['a']);
    expect(board.filter(invitations, 'accepted', NOW).map((i) => i.id)).toEqual(['b']);
  });

  test('it opens on the tab that still needs something done', () => {
    expect(board.initialTab(invitations, NOW)).toBe('pending');
  });

  test('with nothing pending it opens on what there is, never on an empty tab', () => {
    const settled = invitations.filter((i) => i.id !== 'a');

    expect(board.initialTab(settled, NOW)).toBe('accepted');
    expect(board.initialTab([], NOW)).toBe('pending');
  });

  test('tab counts cover every tab, including the empty ones', () => {
    expect(board.tabCounts(invitations, NOW)).toEqual({ pending: 1, accepted: 1, closed: 2 });
  });
});

describe('who may invite whom', () => {
  const scoped = createInvitationBoard({
    invitable: { owner: ['seller', 'courier'], manager: ['courier'] }
  });

  test('a role invites only what it was granted', () => {
    expect(scoped.invitableRoles('owner')).toEqual(['seller', 'courier']);
    expect(scoped.invitableRoles('manager')).toEqual(['courier']);
  });

  test('an ungranted role invites nobody, and the button knows it', () => {
    expect(scoped.invitableRoles('courier')).toEqual([]);
    expect(scoped.invitableRoles(undefined)).toEqual([]);
    expect(scoped.canInvite('courier')).toBe(false);
    expect(scoped.canInvite('owner')).toBe(true);
  });

  test('the granted list cannot be mutated through the reader', () => {
    scoped.invitableRoles('owner').pop();

    expect(scoped.invitableRoles('owner')).toHaveLength(2);
  });
});

describe('delivery', () => {
  test('an address decides whether this goes by mail or by link', () => {
    expect(board.looksLikeEmail('jean@example.test')).toBe(true);
    expect(board.looksLikeEmail('jean@')).toBe(false);
    expect(board.looksLikeEmail('  ')).toBe(false);
    expect(board.looksLikeEmail(null)).toBe(false);
  });
});
