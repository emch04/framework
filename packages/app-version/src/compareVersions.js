/**
 * Comparing two app versions without getting it wrong.
 *
 * AS NUMBERS, NEVER AS TEXT. A string comparison ranks "1.10.0" before
 * "1.9.3": the day an app reached its tenth minor release, every up-to-date
 * phone would have been told it was out of date.
 *
 * AN UNREADABLE VERSION DOES NOT COMPARE. "dev", "1.2.x" or a number answer
 * `null`, never a guess — a guess is how a development build gets locked out
 * as "too old", or how a typo in the server config silences every banner.
 *
 * Prerelease suffixes follow semver ("1.2.0-beta" comes BEFORE "1.2.0",
 * "beta.10" after "beta.9"). Build metadata after "+" is ignored: two binaries
 * with the same public version are the same version to the person holding
 * the phone.
 */

const PATTERN = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Reads "1.2.3", "v1.2", "1.2.3-beta.2", "1.2.3+45".
 * @param {unknown} raw
 * @returns {{ numbers: number[], prerelease: string[] } | null}
 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const match = PATTERN.exec(raw.trim());
  if (!match) return null;
  const numbers = match[1].split('.').map(Number);
  while (numbers.length < 3) numbers.push(0);
  if (numbers.some((n) => !Number.isSafeInteger(n))) return null;
  return { numbers, prerelease: match[2] ? match[2].split('.') : [] };
}

/* Semver precedence for prerelease identifiers: numeric ones compare as
   numbers and rank before alphanumeric ones; a shorter list that is a prefix
   of the other ranks first. */
function comparePrerelease(a, b) {
  /* No suffix is the released version: it ranks AFTER its own prereleases. */
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const aNumeric = /^\d+$/.test(a[i]);
    const bNumeric = /^\d+$/.test(b[i]);
    if (aNumeric && bNumeric) {
      const diff = Number(a[i]) - Number(b[i]);
      if (diff !== 0) return Math.sign(diff);
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return Math.sign(a.length - b.length);
}

/**
 * -1, 0 or 1; `null` when either side is unreadable.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1 | null}
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  const length = Math.max(va.numbers.length, vb.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (va.numbers[i] ?? 0) - (vb.numbers[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return /** @type {-1 | 0 | 1} */ (comparePrerelease(va.prerelease, vb.prerelease) || 0);
}

/**
 * Is this installed version behind `latest`? The server-side question.
 *
 * A MISSING version counts as behind: builds too old to report their version
 * are exactly the phones that most need the announcement. An UNREADABLE one
 * does not — "dev" is a development build, not a stranded user.
 *
 * @param {unknown} installed
 * @param {unknown} latest
 */
function isBehind(installed, latest) {
  /* A broken `latest` in the config tells nobody anything. */
  if (!parseVersion(latest)) return false;
  if (installed === null || installed === undefined || installed === '') return true;
  return compareVersions(installed, latest) === -1;
}

/* The only links the app will open or announce: the stores' https pages or
   their native schemes. Even from our own server, a link elsewhere is refused
   — nobody gets sent anywhere in the name of an update. */
const STORE_LINK = /^(?:https:\/\/|itms-apps:\/\/|market:\/\/)\S+$/;

/** @param {unknown} link */
function isValidStoreLink(link) {
  return typeof link === 'string' && STORE_LINK.test(link.trim());
}

module.exports = { parseVersion, compareVersions, isBehind, isValidStoreLink };
