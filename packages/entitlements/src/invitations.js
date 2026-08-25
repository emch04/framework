/**
 * Inviting someone to join — by link, once, for a while.
 *
 * Every product with accounts grows this flow: an admin invites a colleague by
 * email, the link carries a token, the token opens a registration form with
 * the role already decided. Three properties make it safe, and each one is a
 * bug when missing:
 *
 *   THE TOKEN IS STORED AS A HASH. The database holds its fingerprint, never
 *   the token itself — a leaked collection must not let anyone accept every
 *   pending invitation. The token exists in full exactly twice: in the link,
 *   and in the moment of verification.
 *
 *   ACCEPTANCE IS SINGLE-USE, ATOMICALLY. The claim is one atomic status
 *   transition in the store: two people opening the same link at the same
 *   second create one account, not two.
 *
 *   A NEW INVITATION RETIRES THE OLD ONES. Inviting the same address twice
 *   must not leave two live links around — the older one is exactly the kind
 *   of thing that resurfaces from an inbox months later.
 *
 * Roles are strings you choose. Account creation, email delivery and the URL
 * shape are injected — this module owns the lifecycle, nothing else.
 */
const crypto = require('crypto');

const PENDING = 'pending';
const USED = 'used';
const EXPIRED = 'expired';
const REVOKED = 'revoked';
const FAILED = 'failed';

class InvitationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'InvitationError';
    this.statusCode = statusCode;
  }
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * @param {object} options
 * @param {object} options.store  adapter:
 *   create(data), findByTokenHash(hash), claim(id, from[], patch) — atomic,
 *   update(id, patch), retirePending(email), list(filter).
 * @param {string[]} options.roles  the roles this product may invite into.
 * @param {Function} options.createAccount  async (invitation, form) => account.
 *   Runs INSIDE acceptance: a failure marks the invitation failed, not used.
 * @param {number} [options.ttlMs]  default 24h.
 * @param {Function} [options.buildUrl] (token, invitation) => string.
 * @param {Function} [options.deliver] async ({ invitation, url, token }) => void.
 *   Email is yours; a delivery failure does NOT destroy the invitation — the
 *   link can still be copied from the interface and sent by hand.
 * @param {Function} [options.now]
 * @param {object} [options.logger]
 */
function createInvitations(options = {}) {
  const store = options.store;
  for (const method of ['create', 'findByTokenHash', 'claim', 'update']) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createInvitations requires options.store.${method}().`);
    }
  }

  const roles = new Set(options.roles || []);
  if (!roles.size) {
    throw new Error('createInvitations requires options.roles — the roles this product may invite into.');
  }

  const createAccount = options.createAccount;
  if (typeof createAccount !== 'function') {
    throw new Error('createInvitations requires options.createAccount.');
  }

  const ttlMs = options.ttlMs || 24 * 60 * 60 * 1000;
  const buildUrl = options.buildUrl || null;
  const deliver = options.deliver || null;
  const now = options.now || (() => Date.now());
  const logger = options.logger || { warn() {}, info() {} };

  /**
   * Invite someone.
   *
   * The token is returned HERE and never again: the store only keeps its
   * hash. Whoever calls this puts it in a link or shows it once.
   */
  async function invite({ email, role, invitedBy, tenant, meta } = {}) {
    if (!roles.has(role)) {
      throw new InvitationError(`"${role}" is not a role this product invites into.`);
    }
    if (invitedBy === undefined || invitedBy === null) {
      throw new InvitationError('An invitation must record who sent it.');
    }

    const normalizedEmail = email ? String(email).toLowerCase().trim() : null;

    /* Retire the previous links for this address BEFORE minting a new one:
       an old invitation resurfacing from an inbox months later must find a
       closed door. */
    if (normalizedEmail && typeof store.retirePending === 'function') {
      await store.retirePending(normalizedEmail);
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const invitation = await store.create({
      email: normalizedEmail,
      role,
      tokenHash: hashToken(token),
      status: PENDING,
      invitedBy,
      tenant: tenant === undefined ? null : tenant,
      meta: meta || null,
      createdAt: new Date(now()),
      expiresAt: new Date(now() + ttlMs)
    });

    const url = buildUrl ? buildUrl(token, invitation) : null;

    if (deliver && normalizedEmail) {
      try {
        await deliver({ invitation, url, token });
      } catch (error) {
        /* The invitation stands: the link can still be copied from the
           interface and sent by hand. */
        logger.warn(`[invitations] delivery failed for ${normalizedEmail}: ${error.message}`);
      }
    }

    return { invitation, token, url };
  }

  async function findLive(token) {
    const invitation = await store.findByTokenHash(hashToken(token));
    if (!invitation || invitation.status !== PENDING) {
      /* One message for "unknown" and "already used": which of the two it is,
         is information an attacker probing tokens has no business getting. */
      throw new InvitationError('This link is no longer valid. It may already have been used.');
    }
    if (new Date(invitation.expiresAt).getTime() < now()) {
      await store.update(invitation.id, { status: EXPIRED });
      throw new InvitationError('This invitation link has expired.');
    }
    return invitation;
  }

  /** What the registration page needs to render — never the token hash. */
  async function verify(token) {
    const invitation = await findLive(token);
    return { email: invitation.email, role: invitation.role, tenant: invitation.tenant, invitationId: invitation.id };
  }

  /**
   * Accept: claim the invitation atomically, then create the account.
   *
   * A failed account creation marks the invitation FAILED with the reason —
   * never used. "Used" for an account that does not exist strands the person:
   * their link is dead and their account was never born.
   */
  async function accept(token, form = {}) {
    const invitation = await findLive(token);

    const claimed = await store.claim(invitation.id, [PENDING], { status: USED, usedAt: new Date(now()) });
    if (!claimed) {
      throw new InvitationError('This link is no longer valid. It may already have been used.');
    }

    try {
      const account = await createAccount(claimed, form);
      logger.info(`[invitations] accepted (${claimed.role})`);
      return { invitation: claimed, account };
    } catch (error) {
      await store.update(invitation.id, { status: FAILED, failReason: error.message });
      throw error;
    }
  }

  /** Close a link before it is used. The record stays — a revocation is information. */
  async function revoke(id, { revokedBy } = {}) {
    if (revokedBy === undefined || revokedBy === null) {
      throw new InvitationError('A revocation must record who revoked it.');
    }
    const revoked = await store.claim(id, [PENDING], { status: REVOKED, revokedBy, revokedAt: new Date(now()) });
    if (!revoked) throw new InvitationError('This invitation is not open any more.', 409);
    return revoked;
  }

  async function list(filter = {}) {
    if (typeof store.list !== 'function') {
      throw new Error('createInvitations: options.store.list is required to list.');
    }
    return store.list(filter);
  }

  return { invite, verify, accept, revoke, list, hashToken, roles: [...roles], PENDING, USED, EXPIRED, REVOKED, FAILED };
}

/** In-process store for tests and development. Not persistent. */
function createMemoryInvitationStore() {
  const rows = new Map();
  let sequence = 0;
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r)) : r);

  return {
    async create(data) {
      const id = String(++sequence);
      rows.set(id, { id, ...data });
      return clone(rows.get(id));
    },
    async findByTokenHash(tokenHash) {
      for (const row of rows.values()) if (row.tokenHash === tokenHash) return clone(row);
      return null;
    },
    async claim(id, fromStatuses, patch) {
      const row = rows.get(String(id));
      if (!row || !fromStatuses.includes(row.status)) return null;
      Object.assign(row, patch);
      return clone(row);
    },
    async update(id, patch) {
      const row = rows.get(String(id));
      if (!row) return null;
      Object.assign(row, patch);
      return clone(row);
    },
    async retirePending(email) {
      for (const row of rows.values()) {
        if (row.email === email && row.status === 'pending') row.status = 'expired';
      }
    },
    async list(filter = {}) {
      return [...rows.values()]
        .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
        .map(clone);
    },
    size: () => rows.size
  };
}

module.exports = { createInvitations, createMemoryInvitationStore, InvitationError };
