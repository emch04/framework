/**
 * A new build in the store: should the app say so, and how loudly.
 *
 * Over-the-air updates patch the JavaScript without asking anyone. They do
 * not replace the binary: a new native module, a permission, a security fix
 * in the runtime only arrive through the App Store or the Play Store. And a
 * phone whose owner never opens the store keeps its version forever.
 *
 * These rules are pure; `createStoreVersionWatcher` runs them.
 */
const { compareVersions, parseVersion, isValidStoreLink } = require('./compareVersions');

/** At most one check every six hours: the answer changes once per release. */
const STORE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Where this phone stands: 'up_to_date' | 'available' | 'required' | 'unknown'.
 *
 * 'unknown' when nothing can be asserted — unreadable version, no answer —
 * AND when there is no valid store link: with nowhere to send the person
 * (an App Store page that does not exist yet), a banner or a block would
 * only trap them.
 */
function versionStatus(installed, info) {
  if (!info || !isValidStoreLink(info.storeUrl)) return 'unknown';
  const againstLatest = compareVersions(installed, info.latest);
  if (againstLatest === null) return 'unknown';
  /* An unreadable or missing minimum blocks nobody: in doubt, let people
     work rather than shut the app on them by mistake. */
  if (compareVersions(installed, info.minimum) === -1) return 'required';
  /* Newer than the published one (a test build) is up to date. */
  return againstLatest === -1 ? 'available' : 'up_to_date';
}

/**
 * A dismissed banner is dismissed for ONE version — the one it announced.
 * It comes back when a newer one ships. Dismissed for a version NEWER than
 * the one announced (the server rolled back), it stays closed. An unreadable
 * trace does not silence it.
 */
function isBannerVisible(status, latest, dismissedVersion) {
  if (status !== 'available') return false;
  const comparison = compareVersions(latest, dismissedVersion);
  return comparison === null || comparison === 1;
}

/** Should the app ask the server again? */
function shouldCheckStore({ lastCheck, now, online, force = false, intervalMs = STORE_CHECK_INTERVAL_MS }) {
  if (!online) return false;
  if (force || lastCheck === null || lastCheck === undefined) return true;
  /* A clock set backwards must not silence the check for months. */
  const elapsed = now - lastCheck;
  return elapsed < 0 || elapsed >= intervalMs;
}

/** The part of the answer that concerns THIS platform; `null` if unusable. */
function infoForPlatform(data, platform) {
  if (platform !== 'ios' && platform !== 'android') return null;
  if (!data || typeof data !== 'object') return null;
  const entry = data[platform];
  if (!entry || typeof entry !== 'object') return null;
  const { latest, minimum, storeUrl } = entry;
  if (!parseVersion(latest)) return null;
  return {
    latest: String(latest).trim(),
    minimum: typeof minimum === 'string' && parseVersion(minimum) ? minimum.trim() : null,
    storeUrl: isValidStoreLink(storeUrl) ? storeUrl.trim() : null
  };
}

/** The copy kept on disk: the raw server answer and when it arrived. A damaged copy is "nothing". */
function readStoreCopy(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.receivedAt !== 'number' || !Number.isFinite(value.receivedAt)) return null;
    return { data: value.data, receivedAt: value.receivedAt };
  } catch (_error) {
    return null;
  }
}

module.exports = {
  STORE_CHECK_INTERVAL_MS,
  versionStatus,
  isBannerVisible,
  shouldCheckStore,
  infoForPlatform,
  readStoreCopy
};
