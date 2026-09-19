/**
 * The versions published in the stores, and the public route that serves them.
 *
 * One entry per platform:
 *   - `latest`   — the version live in the store. Phones below it see the
 *                  "new version" banner and get ONE announcement push.
 *   - `minimum`  — below it the app blocks and asks for the update. Raise it
 *                  only for something serious: a security hole, a server
 *                  change old builds cannot survive.
 *   - `storeUrl` — the public store page. `null` means NOTHING is shown or
 *                  sent for that platform: in the original app the App Store
 *                  page did not exist yet, and a banner pointing at nothing
 *                  only strands the person who taps it.
 *
 * Bump `latest` once the build is VISIBLE in the store (after Apple's or
 * Google's review), never before: an announcement that lands before the store
 * page updates sends people to a page still offering the old build.
 */
const { parseVersion, compareVersions, isValidStoreLink } = require('./compareVersions');

const PLATFORMS = Object.freeze(['ios', 'android']);

/* Every launch reads this, including on the sign-in screen, and the answer
   changes once per release: five minutes of shared cache takes the load off
   the API without delaying an announcement in any way anyone would notice. */
const DEFAULT_MAX_AGE_SECONDS = 300;

/**
 * Validates the manifest once, at boot. A typo in `latest` used to be silent:
 * the comparison answered "unreadable", no phone was ever told, and nothing
 * said why. It now fails the deploy instead.
 *
 * @param {Record<string, {latest: string, minimum?: string|null, storeUrl?: string|null}>} config
 */
function defineVersionManifest(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('defineVersionManifest: expected an object keyed by platform');
  }
  const manifest = {};
  for (const [platform, entry] of Object.entries(config)) {
    if (!PLATFORMS.includes(platform)) {
      throw new TypeError(`defineVersionManifest: unknown platform "${platform}" (expected ios or android)`);
    }
    if (!entry || !parseVersion(entry.latest)) {
      throw new TypeError(`defineVersionManifest: ${platform}.latest is not a readable version`);
    }
    const minimum = entry.minimum ?? null;
    if (minimum !== null && !parseVersion(minimum)) {
      throw new TypeError(`defineVersionManifest: ${platform}.minimum is not a readable version`);
    }
    /* A minimum above latest would block every phone with nothing to update to. */
    if (minimum !== null && compareVersions(minimum, entry.latest) === 1) {
      throw new TypeError(`defineVersionManifest: ${platform}.minimum is above ${platform}.latest`);
    }
    const storeUrl = entry.storeUrl ?? null;
    if (storeUrl !== null && !isValidStoreLink(storeUrl)) {
      throw new TypeError(`defineVersionManifest: ${platform}.storeUrl must be https://, itms-apps:// or market://`);
    }
    manifest[platform] = Object.freeze({ latest: entry.latest.trim(), minimum: minimum && minimum.trim(), storeUrl: storeUrl && storeUrl.trim() });
  }
  return Object.freeze(manifest);
}

/**
 * A framework-free handler for the PUBLIC version route: no session, because
 * a phone too old to be accepted must learn it before it can even sign in.
 *
 * @param {{ versions: object | (() => object), maxAgeSeconds?: number }} options
 * @returns {() => { status: number, headers: Record<string, string>, body: object }}
 */
function createVersionHandler({ versions, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS } = /** @type {any} */ ({})) {
  if (!versions) throw new TypeError('createVersionHandler: versions is required');
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new TypeError('createVersionHandler: maxAgeSeconds must be a non-negative integer');
  }
  const read = typeof versions === 'function' ? versions : () => versions;
  return function handleVersionRequest() {
    return {
      status: 200,
      headers: { 'Cache-Control': `public, max-age=${maxAgeSeconds}` },
      body: read()
    };
  };
}

/**
 * Mounts the handler on Express (or anything with `setHeader`/`status`/`json`).
 * `wrap` lets an app keep its own response envelope, e.g. `(data) => ({ data })`.
 */
function toExpressHandler(handler, { wrap = (body) => body } = {}) {
  return function versionRoute(_req, res) {
    const { status, headers, body } = handler();
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res.status(status).json(wrap(body));
  };
}

module.exports = { PLATFORMS, DEFAULT_MAX_AGE_SECONDS, defineVersionManifest, createVersionHandler, toExpressHandler };
