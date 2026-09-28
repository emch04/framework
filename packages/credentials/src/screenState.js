/**
 * Reading the state of the keys, for the screen that manages them.
 *
 * The server side of this package decides what may be stored and hands back a
 * catalogue. THIS side reads that answer — and reads it the way any client
 * should read a payload: without believing a word of its shape. A missing
 * field, a renamed source, a null in place of a space: each one used to be a
 * blank screen with a type error behind it.
 *
 * Two judgements are worth stating.
 *
 * DOUBT FAVOURS THE SECRET. A key whose `secret` flag is missing is masked. A
 * mislabelled key shown in clear is a leak; a mislabelled key shown masked is
 * a minor annoyance.
 *
 * THE UNLOCK WINDOW IS JUDGED WHEN IT IS READ. The server sends a date, not a
 * countdown. Deciding "open" on arrival and trusting it afterwards leaves a
 * settings screen sitting open for an hour, still believing it may write.
 */

const SOURCES = ['interface', 'serveur', 'retiree', 'absente'];
/* The vault's status() speaks English ('environment', 'disconnected',
   'absent'); the screen reads the French names. Without this map a key served
   by the environment read as ABSENT and an unplugged one lost its "unplugged"
   badge — the two cases the screen exists to show. */
const SOURCE_ALIASES = { environment: 'serveur', disconnected: 'retiree', absent: 'absente' };

function readSource(value) {
  const name = String(value);
  if (SOURCES.includes(name)) return name;
  return Object.prototype.hasOwnProperty.call(SOURCE_ALIASES, name) ? SOURCE_ALIASES[name] : 'absente';
}

const BALANCE_STATUSES = ['ok', 'low', 'empty', 'unknown', 'error'];

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A balance as the screen may show it — or an honest "unreadable".
 *
 * A status that claims a number (ok, low, empty) without carrying one is not
 * believed: the screen says the reading failed rather than draw a figure it
 * would have to guess. Absent stays absent: no probe, nothing to draw.
 */
function readBalance(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') return { status: 'error', critical: false, balance: null, rateLimit: null, unit: null, renewable: null, code: null, checkedAt: null };
  const status = BALANCE_STATUSES.includes(String(raw.status)) ? String(raw.status) : 'error';
  const balance = finiteOrNull(raw.balance);
  const needsNumber = status === 'ok' || status === 'low' || status === 'empty';
  const unreadable = needsNumber && balance === null;
  return {
    status: unreadable ? 'error' : status,
    critical: !unreadable && (raw.critical === true || status === 'empty'),
    balance: unreadable || !needsNumber ? null : balance,
    rateLimit: finiteOrNull(raw.rateLimit),
    unit: optional(raw.unit),
    renewable: typeof raw.renewable === 'boolean' ? raw.renewable : null,
    code: optional(raw.code),
    checkedAt: optional(raw.checkedAt)
  };
}

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function optional(value) {
  return value ? String(value) : null;
}

/** The server answer, turned into something a screen can render safely. */
function readSpaces(payload) {
  const raw = payload && typeof payload === 'object' ? payload.spaces : null;
  if (!Array.isArray(raw)) return [];

  return raw.map((item) => {
    const space = item || {};
    const keys = Array.isArray(space.keys) ? space.keys : [];
    return {
      id: text(space.id),
      label: text(space.label),
      hint: text(space.hint),
      keys: keys.map((entry) => {
        const row = entry || {};
        return {
          key: text(row.key),
          label: text(row.label, text(row.key)),
          secret: row.secret !== false,
          placeholder: optional(row.placeholder),
          configured: row.configured === true,
          source: readSource(row.source),
          preview: optional(row.preview),
          help: optional(row.help),
          where: optional(row.where),
          readOnly: row.readOnly === true,
          readOnlyReason: optional(row.readOnlyReason),
          ...(row.balance === undefined ? {} : { balance: readBalance(row.balance) })
        };
      })
    };
  });
}

/** How many of a space's keys are in place — the badge on its tab. */
function coverageOf(space) {
  const keys = (space && space.keys) || [];
  return { done: keys.filter((entry) => entry.configured).length, total: keys.length };
}

/**
 * What is left to set, across every space.
 *
 * A key deliberately unplugged counts as missing. It is a choice, but a choice
 * that leaves a service disconnected — the screen must show it, not bury it.
 */
function missingKeys(spaces) {
  return (Array.isArray(spaces) ? spaces : []).flatMap((space) =>
    space.keys
      .filter((entry) => !entry.configured)
      .map((entry) => ({ space: space.label, ...entry }))
  );
}

/**
 * Which space to open on arrival: the one with the most left to do — that is
 * where there is something to do. On a tie, the first: the catalogue's order
 * means something.
 */
function firstSpaceToOpen(spaces) {
  const list = Array.isArray(spaces) ? spaces : [];
  if (!list.length) return null;
  let best = list[0];
  let bestGap = -1;
  for (const space of list) {
    const { done, total } = coverageOf(space);
    const gap = total - done;
    if (gap > bestGap) {
      best = space;
      bestGap = gap;
    }
  }
  return best.id;
}

/**
 * Is the editing window open, and for how much longer?
 * @param {*} raw  The server payload carrying `unlockedUntil`.
 * @param {number} [now]
 */
function unlockState(raw, now = Date.now()) {
  const value = raw && typeof raw === 'object' ? raw.unlockedUntil : null;
  if (!value) return { unlocked: false, minutesLeft: 0 };
  const until = new Date(String(value)).getTime();
  if (!Number.isFinite(until) || until <= now) return { unlocked: false, minutesLeft: 0 };
  /* Never zero while it is open: "0 minutes left" reads as closed. */
  return { unlocked: true, minutesLeft: Math.max(1, Math.ceil((until - now) / 60000)) };
}

/**
 * The balances that need attention, most urgent first: empty, then critical,
 * then low, then unreadable. A reading that failed is listed — a balance you
 * cannot see is one you cannot watch.
 */
function balanceAlerts(spaces) {
  const rank = (balance) => {
    if (balance.status === 'empty') return 0;
    if (balance.status === 'low' && balance.critical) return 1;
    if (balance.status === 'low') return 2;
    if (balance.status === 'error') return 3;
    return -1;
  };
  return (Array.isArray(spaces) ? spaces : [])
    .flatMap((space) => (space.keys || [])
      .filter((entry) => entry.balance && rank(entry.balance) >= 0)
      .map((entry) => ({ space: space.label, key: entry.key, label: entry.label, balance: entry.balance, rank: rank(entry.balance) })))
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _rank, ...alert }) => alert);
}

/** Digits only — what gets pasted out of an e-mail rarely is. */
function cleanUnlockCode(input, length = 6) {
  return text(input).replace(/\D/g, '').slice(0, length);
}

module.exports = {
  readSpaces, coverageOf, missingKeys, firstSpaceToOpen, unlockState, cleanUnlockCode,
  readBalance, balanceAlerts
};
