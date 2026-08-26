/**
 * Watching for what arrived while the app was open.
 *
 * Push handles a closed app. An OPEN app receives nothing: the bell sat there
 * stale until the person navigated away and back. So the foreground sweeps the
 * server on a timer — and the three rules below are what keep that from
 * becoming an annoyance.
 *
 * THE FIRST SWEEP RAISES NOTHING. On launch every unread item is "new" from
 * the phone's point of view. Twenty banners at once is how an app gets its
 * notifications switched off for good.
 *
 * THE MARK NEVER MOVES BACKWARDS. Otherwise the same item banners again on the
 * next sweep, and the one after.
 *
 * AN UNREADABLE DATE IS NOT NOW. Treating a malformed date as the current time
 * would banner the entire backlog.
 */

/** Half a minute: often enough to feel live, rare enough to ignore on battery. */
const FOREGROUND_POLL_MS = 30_000;

function timeOf(value) {
  return Date.parse(typeof value === 'string' ? value : '');
}

/**
 * The items worth a banner: unread, and newer than the last sweep.
 * @param {Array<{createdAt?: string, read?: boolean}>} items
 * @param {string|null} lastSeenISO  Null on the first sweep.
 */
function freshItems(items, lastSeenISO) {
  if (!Array.isArray(items) || !lastSeenISO) return [];
  const lastSeen = timeOf(lastSeenISO);
  if (Number.isNaN(lastSeen)) return [];
  return items.filter((item) => {
    if (!item || item.read) return false;
    const created = timeOf(item.createdAt);
    return !Number.isNaN(created) && created > lastSeen;
  });
}

/** The new mark: the latest arrival seen, or the old mark if nothing is newer. */
function nextStamp(items, previous) {
  let best = previous ? timeOf(previous) : Number.NaN;
  for (const item of Array.isArray(items) ? items : []) {
    const created = timeOf(item && item.createdAt);
    if (!Number.isNaN(created) && (Number.isNaN(best) || created > best)) best = created;
  }
  return Number.isNaN(best) ? (previous ?? null) : new Date(best).toISOString();
}

/**
 * Sweep only in the foreground, only for someone signed in.
 * In the background push takes over, and the OS would kill the timer anyway.
 */
function shouldPoll(appState, hasUser) {
  return appState === 'active' && Boolean(hasUser);
}

module.exports = { FOREGROUND_POLL_MS, freshItems, nextStamp, shouldPoll };
