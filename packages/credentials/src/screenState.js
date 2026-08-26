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
          source: SOURCES.includes(String(row.source)) ? String(row.source) : 'absente',
          preview: optional(row.preview),
          help: optional(row.help),
          where: optional(row.where),
          readOnly: row.readOnly === true,
          readOnlyReason: optional(row.readOnlyReason)
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

/** Digits only — what gets pasted out of an e-mail rarely is. */
function cleanUnlockCode(input, length = 6) {
  return text(input).replace(/\D/g, '').slice(0, length);
}

module.exports = { readSpaces, coverageOf, missingKeys, firstSpaceToOpen, unlockState, cleanUnlockCode };
