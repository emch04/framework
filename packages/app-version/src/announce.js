/**
 * Announcing a new store version — once.
 *
 * When `latest` goes up in the manifest and the server is deployed, every
 * phone of that platform that is BEHIND receives one push, in its owner's
 * language. Five rules, each paid for by a real way this goes wrong:
 *
 * ONE ANNOUNCEMENT PER PLATFORM AND VERSION, CLAIMED BEFORE SENDING. The job
 * runs on every instance of a cluster and after every restart. Written after
 * the send, the record lets a second instance — or a crash halfway through —
 * push the same news twice. Claimed first, the worst case is a partial send,
 * never a duplicate: a duplicate is what gets notifications switched off.
 *
 * DAYTIME ONLY. A new version is not urgent; it does not wake anyone up.
 * Outside the window the job simply waits for the next pass.
 *
 * ONLY PHONES THAT ARE BEHIND. A phone already on `latest` being told to
 * update reads as a bug. A phone that never reported its version counts as
 * behind: builds too old to report it are the ones that most need telling.
 *
 * IN THE ACCOUNT'S LANGUAGE. No text lives here: the caller provides it per
 * language, or through its own translation function.
 *
 * NOTHING WITHOUT A PUBLIC STORE PAGE. `storeUrl: null` means there is
 * nowhere to send people; the announcement would only frustrate them.
 *
 * And the switch: this sends real pushes to real phones. A development
 * machine pointed at the production database once ran every scheduled job
 * against it. `enabled` defaults to OFF and must be turned on explicitly,
 * on the one production server — see `isAnnouncementEnabled`.
 */
const { isBehind, isValidStoreLink, parseVersion } = require('./compareVersions');
const { PLATFORMS } = require('./manifest');

const DEFAULT_WINDOW = Object.freeze({ startHour: 7, endHour: 20 });
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_ENV_VARIABLE = 'ANNOUNCE_VERSIONS';

/**
 * The switch, read from the environment. Strictly "1": "true", "yes" or a
 * stray value copied from another project do not turn on real pushes.
 */
function isAnnouncementEnabled(env = process.env, variable = DEFAULT_ENV_VARIABLE) {
  return Boolean(env) && env[variable] === '1';
}

/** Is `now` inside [startHour, endHour) in UTC? */
function isWithinDaytime(now, window = DEFAULT_WINDOW) {
  const hour = now.getUTCHours();
  return hour >= window.startHour && hour < window.endHour;
}

function announcementId(platform, version) {
  return `${platform}:${version}`;
}

/**
 * The reference store. Real deployments give a store with a UNIQUE key on
 * `id` (a primary key, a unique index): `claim` must be atomic across
 * instances, or the first rule above is a wish.
 */
function createMemoryAnnouncementStore() {
  const records = new Map();
  return {
    async claim({ id, platform, version }) {
      if (records.has(id)) return false;
      records.set(id, { id, platform, version, sent: 0, failed: 0, finishedAt: null });
      return true;
    },
    async complete(id, { sent, failed, finishedAt }) {
      const record = records.get(id);
      if (record) Object.assign(record, { sent, failed, finishedAt });
    },
    async get(id) {
      const record = records.get(id);
      return record ? { ...record } : null;
    }
  };
}

/* Texts come from the caller. A catalog `{ en: { title, body } }` where each
   entry is a string with a {version} placeholder or a function; or a
   `translate(language, params)` returning `{ title, body }`. */
function buildComposer({ messages, translate, defaultLanguage }) {
  if (typeof translate === 'function') {
    return (language, params) => {
      const text = translate(language, params) || translate(defaultLanguage, params);
      if (!text || typeof text.title !== 'string' || typeof text.body !== 'string') {
        throw new TypeError(`translate returned no { title, body } for "${language}"`);
      }
      return text;
    };
  }
  if (!messages || typeof messages !== 'object' || !messages[defaultLanguage]) {
    throw new TypeError(`createVersionAnnouncer: provide translate(), or messages with an entry for "${defaultLanguage}"`);
  }
  const render = (template, params) => (typeof template === 'function'
    ? template(params)
    : String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole)));
  return (language, params) => {
    const entry = messages[language] || messages[defaultLanguage];
    return { title: render(entry.title, params), body: render(entry.body, params) };
  };
}

/**
 * @param {object} options
 * @param {object | (() => object)} options.versions   The manifest (see defineVersionManifest).
 * @param {{claim: Function, complete: Function}} options.store
 * @param {(platform: string) => Promise<Array<{id: string, appVersion?: string|null, language?: string|null}>>} options.listDevices
 *        The platform's push-enabled devices.
 * @param {(devices: object[], message: object) => Promise<{sent: number, failed: number}>} options.send
 * @param {(devices: object[]) => Promise<Map<string, string> | Record<string, string>>} [options.languagesFor]
 *        Batch lookup, device id → language, when the language lives on the account and not the device.
 * @param {boolean | (() => boolean)} [options.enabled=false]
 */
function createVersionAnnouncer(options = /** @type {any} */ ({})) {
  const {
    versions,
    store,
    listDevices,
    send,
    languagesFor,
    messages,
    translate,
    defaultLanguage = 'en',
    payload = {},
    enabled = false,
    window = DEFAULT_WINDOW,
    batchSize = DEFAULT_BATCH_SIZE,
    platforms = PLATFORMS,
    now = () => new Date(),
    logger = null
  } = options;

  if (!versions) throw new TypeError('createVersionAnnouncer: versions is required');
  if (!store || typeof store.claim !== 'function' || typeof store.complete !== 'function') {
    throw new TypeError('createVersionAnnouncer: store must have claim() and complete()');
  }
  if (typeof listDevices !== 'function') throw new TypeError('createVersionAnnouncer: listDevices is required');
  if (typeof send !== 'function') throw new TypeError('createVersionAnnouncer: send is required');
  if (!(window.startHour >= 0 && window.endHour <= 24 && window.startHour < window.endHour)) {
    throw new TypeError('createVersionAnnouncer: window needs 0 <= startHour < endHour <= 24');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError('createVersionAnnouncer: batchSize must be >= 1');

  const compose = buildComposer({ messages, translate, defaultLanguage });
  const readVersions = typeof versions === 'function' ? versions : () => versions;
  const isEnabled = typeof enabled === 'function' ? enabled : () => enabled === true;

  async function languageMap(devices) {
    if (typeof languagesFor !== 'function') return new Map();
    const found = await languagesFor(devices);
    return found instanceof Map ? found : new Map(Object.entries(found || {}));
  }

  async function announcePlatform(platform, entry) {
    const latest = entry && entry.latest;
    if (!parseVersion(latest) || !isValidStoreLink(entry.storeUrl)) return null;

    const id = announcementId(platform, latest);
    /* The claim comes FIRST — before listing a single device. */
    if (!(await store.claim({ id, platform, version: latest }))) return null;

    const devices = (await listDevices(platform)).filter((device) => device && isBehind(device.appVersion, latest));
    const languages = await languageMap(devices);

    let sent = 0;
    let failed = 0;
    for (let start = 0; start < devices.length; start += batchSize) {
      const batch = devices.slice(start, start + batchSize);
      /* One send per language in the batch: the text follows the account. */
      const byLanguage = new Map();
      for (const device of batch) {
        const language = languages.get(String(device.id)) || device.language || defaultLanguage;
        if (!byLanguage.has(language)) byLanguage.set(language, []);
        byLanguage.get(language).push(device);
      }
      for (const [language, targets] of byLanguage) {
        const text = compose(language, { version: latest, platform });
        try {
          const result = await send(targets, { ...payload, ...text, version: latest, platform, language });
          sent += Number(result && result.sent) || 0;
          failed += Number(result && result.failed) || 0;
        } catch (error) {
          /* The claim is already written: throwing here would strand every
             remaining batch for good. Count the loss and carry on. */
          failed += targets.length;
          if (logger) logger.error(`[app-version] ${id} batch failed: ${error && error.message}`);
        }
      }
    }
    await store.complete(id, { sent, failed, finishedAt: now() });
    if (logger) logger.info(`[app-version] ${id} announced: ${sent} sent, ${failed} failed`);
    return { platform, version: latest, sent, failed };
  }

  /** Announces the versions not announced yet. Safe to call on every tick. */
  async function run() {
    if (!isEnabled()) return [];
    if (!isWithinDaytime(now(), window)) return [];
    const manifest = readVersions() || {};
    const results = [];
    for (const platform of platforms) {
      const result = await announcePlatform(platform, manifest[platform]);
      if (result) results.push(result);
    }
    return results;
  }

  return { run };
}

/**
 * Runs the announcer on a timer. The switch is re-read on every tick (pass
 * `enabled` as a function), so turning it off needs no restart.
 * `lock(name, ttlMs, fn)` is the app's shared job lock: optional, since the
 * claim already prevents duplicates, but it spares N instances listing every
 * device at the same second.
 */
function startAnnouncementSchedule({
  announcer,
  intervalMs = 30 * 60 * 1000,
  lock = null,
  lockName = 'app-version-announcement',
  onError = () => {},
  timers = { setInterval, clearInterval }
} = /** @type {any} */ ({})) {
  if (!announcer || typeof announcer.run !== 'function') throw new TypeError('startAnnouncementSchedule: announcer is required');
  const tick = () => {
    const job = lock ? lock(lockName, Math.floor(intervalMs * 0.8), () => announcer.run()) : announcer.run();
    return Promise.resolve(job).catch(onError);
  };
  const handle = timers.setInterval(tick, intervalMs);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return { tick, stop: () => timers.clearInterval(handle) };
}

module.exports = {
  DEFAULT_WINDOW,
  DEFAULT_BATCH_SIZE,
  DEFAULT_ENV_VARIABLE,
  isAnnouncementEnabled,
  isWithinDaytime,
  announcementId,
  createMemoryAnnouncementStore,
  createVersionAnnouncer,
  startAnnouncementSchedule
};
