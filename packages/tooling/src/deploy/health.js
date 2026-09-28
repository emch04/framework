/* global fetch, AbortSignal */
const { ToolingError } = require('../errors');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET `url` until it answers `expectStatus`, at most `attempts` times, with
 * `intervalMs` between tries and `timeoutMs` per try.
 */
async function checkHealth(options) {
  const {
    url,
    attempts = 6,
    intervalMs = 5000,
    timeoutMs = 15000,
    expectStatus = 200,
    sleep = defaultSleep
  } = options;
  const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    throw new ToolingError('HEALTH_NO_FETCH', 'Aucune implementation de fetch disponible.', 500);
  }

  let lastStatus = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      lastStatus = response.status;
      lastError = null;
      if (response.status === expectStatus) {
        return { ok: true, url, attempts: attempt, status: response.status };
      }
    } catch (error) {
      lastStatus = 0;
      lastError = error && (error.code || error.name) ? error.code || error.name : 'erreur';
    }
    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }

  return { ok: false, url, attempts, status: lastStatus, error: lastError };
}

/** Pure: names of pm2 processes not online, and expected names that are missing. */
function analysePm2(jlist, expected = []) {
  if (!jlist) {
    return { readable: false, offline: [], missing: [] };
  }
  let processes;
  try {
    processes = JSON.parse(jlist);
  } catch (_error) {
    return { readable: false, offline: [], missing: [] };
  }
  if (!Array.isArray(processes)) {
    return { readable: false, offline: [], missing: [] };
  }
  const offline = processes
    .filter((proc) => !proc.pm2_env || proc.pm2_env.status !== 'online')
    .map((proc) => proc.name);
  const names = new Set(processes.map((proc) => proc.name));
  const missing = expected.filter((name) => !names.has(name));
  return { readable: true, offline: [...new Set(offline)], missing, count: processes.length };
}

/** Pure: age in whole days of the date that starts `line` (YYYY-MM-DD...). */
function backupAgeDays(line, now = Date.now()) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(line || '').trim());
  if (!match) {
    return null;
  }
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  if (Number.isNaN(day)) {
    return null;
  }
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((today - day) / 86400000);
}

module.exports = {
  analysePm2,
  backupAgeDays,
  checkHealth
};
