/**
 * The invitation list, as a screen needs to see it.
 *
 * The server side of invitations lives next door in this package: it mints
 * links, hashes them, and accepts them once. THIS reads what came back and
 * decides what to show — and one rule earns the whole module.
 *
 * A PENDING INVITATION PAST ITS DATE IS EXPIRED, WHATEVER THE SERVER SAYS.
 * A server only flips that status when somebody opens the link; until then the
 * row keeps saying "pending". Rendering it as-is promises a working link that
 * is already dead — the person sends it, the recipient gets an error, and the
 * sender is left to work out why. The status is therefore recomputed at read
 * time, never trusted from the payload.
 *
 * The tabs follow from the same idea: "closed" gathers expired AND failed,
 * because in both cases the only possible next move is to issue a new one.
 */

/** Under six hours: chasing it beats waiting for it. */
const URGENT_HOURS = 6;
/* Every status this package's server side can produce. Miss one — 'revoked'
   was missed — and a revoked invitation reads as pending: still actionable on
   screen, dead on the server. */
const STATUSES = ['pending', 'used', 'expired', 'revoked', 'failed'];
const TABS = ['pending', 'accepted', 'closed'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : (typeof value === 'number' ? String(value) : '');
}

/**
 * @param {object} [options]
 * @param {number} [options.urgentHours]
 * @param {Object<string,string[]>} [options.invitable]  role => roles it may invite.
 */
function createInvitationBoard(options = {}) {
  const urgentHours = Number.isFinite(options.urgentHours) ? options.urgentHours : URGENT_HOURS;
  const invitable = options.invitable || {};

  function read(raw) {
    if (!isRecord(raw)) return null;
    const id = text(raw._id) || text(raw.id);
    if (!id) return null;

    const status = text(raw.status).toLowerCase();
    return {
      id,
      email: text(raw.email),
      role: text(raw.role),
      /* An unfamiliar status reads as pending: the row stays on screen and
         actionable rather than vanishing into a tab nobody opens. */
      status: STATUSES.includes(status) ? status : 'pending',
      expiresAt: text(raw.expiresAt) || null,
      usedAt: text(raw.usedAt) || null,
      createdAt: text(raw.createdAt) || null,
      failReason: text(raw.failReason)
    };
  }

  function readMany(payload) {
    const rows = Array.isArray(payload)
      ? payload
      : (isRecord(payload) && Array.isArray(payload.invitations) ? payload.invitations : []);
    return rows.map(read).filter(Boolean);
  }

  /** The status as it truly stands right now. */
  function effectiveStatus(invitation, now = new Date()) {
    if (!invitation) return 'pending';
    if (invitation.status !== 'pending') return invitation.status;
    if (!invitation.expiresAt) return 'pending';
    const end = Date.parse(invitation.expiresAt);
    if (!Number.isFinite(end)) return 'pending';
    return end <= now.getTime() ? 'expired' : 'pending';
  }

  /** Rounded up, so an invitation with minutes left never reads as "0 hours". */
  function hoursLeft(invitation, now = new Date()) {
    if (effectiveStatus(invitation, now) !== 'pending' || !invitation.expiresAt) return null;
    const end = Date.parse(invitation.expiresAt);
    if (!Number.isFinite(end)) return null;
    return Math.max(0, Math.ceil((end - now.getTime()) / 3600000));
  }

  function tone(invitation, now = new Date()) {
    const status = effectiveStatus(invitation, now);
    if (status === 'used') return 'success';
    if (status === 'failed') return 'danger';
    if (status === 'expired' || status === 'revoked') return 'neutral';
    const left = hoursLeft(invitation, now);
    return left !== null && left <= urgentHours ? 'warning' : 'neutral';
  }

  /** Three numbers that say where recruitment stands without reading the list. */
  function counts(invitations, now = new Date()) {
    const list = Array.isArray(invitations) ? invitations : [];
    let pending = 0;
    let accepted = 0;
    for (const invitation of list) {
      const status = effectiveStatus(invitation, now);
      if (status === 'pending') pending += 1;
      else if (status === 'used') accepted += 1;
    }
    return { total: list.length, pending, accepted };
  }

  function tabOf(invitation, now) {
    const status = effectiveStatus(invitation, now);
    if (status === 'pending') return 'pending';
    if (status === 'used') return 'accepted';
    return 'closed';
  }

  function filter(invitations, tab, now = new Date()) {
    return (Array.isArray(invitations) ? invitations : []).filter((invitation) => tabOf(invitation, now) === tab);
  }

  function tabCounts(invitations, now = new Date()) {
    const result = { pending: 0, accepted: 0, closed: 0 };
    for (const invitation of Array.isArray(invitations) ? invitations : []) {
      result[tabOf(invitation, now)] += 1;
    }
    return result;
  }

  /** Opens on what still needs doing; failing that, on a tab that has rows. */
  function initialTab(invitations, now = new Date()) {
    const totals = tabCounts(invitations, now);
    return TABS.find((tab) => totals[tab] > 0) || 'pending';
  }

  return {
    tabs: [...TABS],
    urgentHours,
    read,
    readMany,
    effectiveStatus,
    hoursLeft,
    tone,
    counts,
    filter,
    tabCounts,
    initialTab,

    /** What this role may invite. A copy: the caller must not edit the table. */
    invitableRoles(role) {
      const list = role ? invitable[role] : null;
      return Array.isArray(list) ? [...list] : [];
    },

    canInvite(role) {
      return this.invitableRoles(role).length > 0;
    },

    /** Decides whether the invitation goes out by mail or as a bare link. */
    looksLikeEmail(value) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value));
    }
  };
}

module.exports = { URGENT_HOURS, createInvitationBoard };
