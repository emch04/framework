/**
 * A role only one account may ever hold — the founder, the platform owner —
 * and the sentinel that keeps it that way.
 *
 * The top role holds the service keys, approves tenants, keeps the access of
 * last resort. A second account at that rank doubles all of it in silence,
 * and two holders can revoke each other. The rule is simple; enforcing it is
 * not, because an account gets a role through many doors:
 *
 *   CREATION   — a staff form, an import, a seed script.
 *   PROMOTION  — an update that sets the role on an existing account.
 *   RENAMING   — an account taking the identifier (email) the holder is
 *                recognised by, so that the sentinel keeps the wrong one.
 *   DIRECT WRITES — a database shell, a restored backup, a hand-written
 *                migration: nothing in the application runs at all.
 *
 * Guards scattered over three places (a validator here, a `delete body.role`
 * there, an enum elsewhere) each close one door and none SAYS the rule: the
 * fourth door added next year passes without meeting anything. The decision
 * lives here, once; every write path calls it; and a periodic sweep catches
 * what came in through a door no code watches.
 *
 * Every refused attempt raises an alert. Someone trying to become the holder
 * is information worth more than the refusal itself.
 *
 * The role name, the holder's identifier, the store, the alert and its texts
 * are all injected: nothing here knows what product it protects.
 */

class UniqueRoleError extends Error {
  constructor(reason, statusCode, message) {
    super(message || reason);
    this.name = 'UniqueRoleError';
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

/* Case and spaces must not open a side door: " OWNER " is the same role to a
   human reading the database, and to any permission check that normalises. */
const normalize = (value) => String(value === undefined || value === null ? '' : value).trim().toLowerCase();

const STATUS = {
  role_taken: 409,
  bootstrap_closed: 403,
  identity_taken: 409,
  holder_protected: 403,
  last_holder: 409
};

const NOOP_LOGGER = { error() {}, warn() {}, info() {} };

/**
 * Which accounts to remove, and which one to keep. Pure.
 *
 * FOUR SAFEGUARDS, each one against removing the REAL holder — the code
 * deletes accounts, and in doubt it must do nothing:
 *   1. No anchor configured: nobody is known to be legitimate; removing
 *      would be picking at random.
 *   2. Several holders and NONE carries the anchor: the holder may have
 *      changed address; removing everyone would behead the platform.
 *   3. The anchored account is never in the list.
 *   4. A single holder is never removed, even if it does not match the
 *      anchor — but that mismatch is reported (see `sweep`).
 */
function pickIntruders({ accounts = [], anchor, identifierOf = (a) => a.email, idOf = defaultIdOf } = {}) {
  const wanted = normalize(anchor);
  if (!wanted) return { intruders: [], holder: null, reason: 'anchor_missing' };

  const holder = accounts.find((account) => normalize(identifierOf(account)) === wanted) || null;
  if (accounts.length === 0) return { intruders: [], holder: null, reason: 'none' };
  if (accounts.length === 1) return { intruders: [], holder, reason: holder ? 'single' : 'anchor_mismatch' };
  if (!holder) return { intruders: [], holder: null, reason: 'anchor_not_found' };

  return {
    intruders: accounts.filter((account) => String(idOf(account)) !== String(idOf(holder))),
    holder,
    reason: 'intruders'
  };
}

function defaultIdOf(account) {
  if (!account) return undefined;
  return account.id !== undefined ? account.id : account._id;
}

/**
 * @param {object} options
 * @param {string} options.role  the role only one account may hold.
 * @param {string|Function} [options.anchor]  the identifier of the legitimate
 *   holder (or a function returning it, read at each call so a configuration
 *   change needs no restart). Without it the sweep never removes anything.
 * @param {object} [options.store]  for the checks and the sweep:
 *   findHolders(role) -> accounts holding the role (match it case-insensitively);
 *   remove(account, role) -> removes it ONLY IF it still holds `role`.
 * @param {Function} [options.alert]  async (event) => void. Receives a
 *   structured event ({ kind, role, actor, account, holder, intruders, … });
 *   the recipient and the wording are yours. Never blocks a refusal.
 * @param {object} [options.messages]  reason -> text for refusals. Without
 *   one, the message is the reason code: no wording is invented here.
 * @param {boolean} [options.allowBootstrap]  default true: the FIRST holder may
 *   be created or promoted while none exists. Pass false on application paths
 *   when the holder is only ever seeded by a script.
 */
function createUniqueRole(options = {}) {
  const role = options.role;
  if (typeof role !== 'string' || !normalize(role)) {
    throw new Error('createUniqueRole requires options.role — the role only one account may hold.');
  }
  const wantedRole = normalize(role);
  const anchorOption = options.anchor;
  const store = options.store || null;
  const alert = typeof options.alert === 'function' ? options.alert : null;
  const messages = options.messages || {};
  const allowBootstrap = options.allowBootstrap !== false;
  const idOf = options.idOf || defaultIdOf;
  const identifierOf = options.identifierOf || ((account) => account && account.email);
  const roleOf = options.roleOf || ((account) => account && account.role);
  const logger = options.logger || NOOP_LOGGER;

  const isRole = (value) => normalize(value) === wantedRole;
  const isHolder = (account) => Boolean(account) && isRole(roleOf(account));
  const sameAccount = (a, b) => Boolean(a) && Boolean(b) && idOf(a) !== undefined && String(idOf(a)) === String(idOf(b));
  const resolveAnchor = () => (typeof anchorOption === 'function' ? anchorOption() : anchorOption);

  function requireStore(method) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createUniqueRole: options.store.${method}() is required for this check.`);
    }
  }

  async function raise(event) {
    if (!alert) return;
    try {
      await alert({ role, ...event });
    } catch (error) {
      /* The alert never decides the outcome: a mail server down must neither
         let the attempt through nor hide the refusal. */
      logger.error(`[unique-role] alert "${event.kind}" not sent: ${error.message}`);
    }
  }

  async function refuse(reason, event) {
    await raise(event);
    throw new UniqueRoleError(reason, STATUS[reason], messages[reason]);
  }

  /** Pure: may this role be set, given whether ANOTHER holder exists? */
  function verdict({ role: nextRole, otherHolderExists }) {
    if (!isRole(nextRole)) return { refused: false };
    if (otherHolderExists) return { refused: true, reason: 'role_taken', statusCode: STATUS.role_taken };
    if (!allowBootstrap) return { refused: true, reason: 'bootstrap_closed', statusCode: STATUS.bootstrap_closed };
    return { refused: false };
  }

  /* "ANOTHER holder", not "a holder": the current holder must be able to save
     their own account — a new name, a language — without hitting themselves. */
  async function otherHolders(account) {
    requireStore('findHolders');
    const holders = (await store.findHolders(role)) || [];
    return holders.filter((h) => isHolder(h) && !sameAccount(h, account));
  }

  /** A new account asking for the role. */
  async function assertCanCreate({ role: nextRole, actor, account } = {}) {
    if (!isRole(nextRole)) return;
    const others = await otherHolders(null);
    const decision = verdict({ role: nextRole, otherHolderExists: others.length > 0 });
    if (decision.refused) {
      await refuse(decision.reason, { kind: 'create_refused', actor, account, holder: others[0] || null });
    }
  }

  /**
   * An existing account changing role: promotion INTO the role, and demotion
   * OUT of it. Demoting the holder is refused too — the platform would be left
   * without anyone at the top, and nobody able to name a new one.
   */
  async function assertCanChangeRole({ account, nextRole, actor } = {}) {
    if (isHolder(account) && !isRole(nextRole)) {
      await refuse('last_holder', { kind: 'demotion_refused', actor, account });
    }
    if (!isRole(nextRole)) return;
    /* Never trust `account.role` to say "already the holder": a caller that
       passes the account AFTER applying the change would skip the check
       entirely. Only the store says who holds the role; the account is
       excluded by id, never by what it claims. */
    const others = await otherHolders(account);
    const decision = verdict({ role: nextRole, otherHolderExists: others.length > 0 });
    if (decision.refused) {
      await refuse(decision.reason, { kind: 'promotion_refused', actor, account, holder: others[0] || null });
    }
  }

  /**
   * An account changing its identifier. Taking the holder's identifier is
   * refused for anyone but the holder: the sweep recognises the legitimate
   * holder BY that identifier, so an account renamed onto it would be the one
   * kept, and the real holder the one removed.
   */
  async function assertCanRename({ account, nextIdentifier, actor } = {}) {
    const anchor = normalize(resolveAnchor());
    if (!anchor || normalize(nextIdentifier) !== anchor) return;
    /* The holder is whoever the STORE says holds the role — not what the
       account object passed in claims. */
    requireStore('findHolders');
    const holders = (await store.findHolders(role)) || [];
    if (holders.some((h) => isHolder(h) && sameAccount(h, account))) return;
    await refuse('identity_taken', { kind: 'rename_refused', actor, account, nextIdentifier });
  }

  /** Anyone but the holder touching the holder's account (update, delete, suspend). */
  async function assertCanModify({ target, actor } = {}) {
    if (!isHolder(target) || sameAccount(target, actor)) return;
    await refuse('holder_protected', { kind: 'modify_refused', actor, account: target });
  }

  /**
   * The sentinel: find every holder, keep the anchored one, remove the rest,
   * tell the holder. Run it on a schedule — hourly, not daily: every hour
   * between an intruder's arrival and its removal is an hour of full access —
   * and under a lock shared by all instances, or each one removes the same
   * account at the same time.
   *
   * Removal comes BEFORE the alert: a mail server down must not leave the
   * intruder in place.
   */
  async function sweep({ dryRun = false } = {}) {
    requireStore('findHolders');
    if (!dryRun) requireStore('remove');

    const accounts = ((await store.findHolders(role)) || []).filter(isHolder);
    const { intruders, holder, reason } = pickIntruders({ accounts, anchor: resolveAnchor(), identifierOf, idOf });

    if (!intruders.length) {
      /* Only the abnormal speaks: a healthy platform passes here every hour
         without a word. */
      if ((reason === 'anchor_missing' && accounts.length > 1) || reason === 'anchor_not_found' || reason === 'anchor_mismatch') {
        /* anchor_mismatch: ONE holder, and not the anchored one. Nothing is
           removed — it may be the holder after an address change — but it is
           also exactly what a REPLACED holder looks like. */
        if (!dryRun) await raise({ kind: reason, accounts, holder });
      }
      return { removed: [], failed: [], holder, reason, dryRun };
    }

    const removed = [];
    const failed = [];
    for (const intruder of intruders) {
      if (dryRun) {
        removed.push(intruder);
        continue;
      }
      try {
        /* The store removes only if the account STILL holds the role: if it
           changed rank between the read and the write, a regular account is
           not deleted by mistake. */
        const done = await store.remove(intruder, role);
        if (done === false) continue;
        removed.push(intruder);
      } catch (error) {
        logger.error(`[unique-role] could not remove ${String(idOf(intruder))}: ${error.message}`);
        failed.push(intruder);
      }
    }

    if (!dryRun && (removed.length || failed.length)) {
      await raise({ kind: 'intruders_removed', holder, intruders: removed, failed });
    }
    return { removed, failed, holder, reason, dryRun };
  }

  return {
    role,
    isRole,
    isHolder,
    verdict,
    assertCanCreate,
    assertCanChangeRole,
    assertCanRename,
    assertCanModify,
    sweep
  };
}

/** In-process account store for tests and development. Not persistent. */
function createMemoryUniqueRoleStore(initial = []) {
  const rows = new Map();
  let sequence = 0;
  const clone = (row) => (row ? JSON.parse(JSON.stringify(row)) : row);

  function add(account) {
    const id = account.id !== undefined ? String(account.id) : String(++sequence);
    rows.set(id, { ...account, id });
    return clone(rows.get(id));
  }
  initial.forEach(add);

  return {
    add,
    async findHolders(role) {
      return [...rows.values()].filter((row) => normalize(row.role) === normalize(role)).map(clone);
    },
    async remove(account, role) {
      const row = rows.get(String(defaultIdOf(account)));
      if (!row || normalize(row.role) !== normalize(role)) return false;
      rows.delete(row.id);
      return true;
    },
    update(id, patch) {
      const row = rows.get(String(id));
      if (row) Object.assign(row, patch);
      return clone(row);
    },
    list: () => [...rows.values()].map(clone),
    size: () => rows.size
  };
}

module.exports = { createUniqueRole, createMemoryUniqueRoleStore, pickIntruders, UniqueRoleError };
