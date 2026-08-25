/**
 * Pours stored keys into `process.env`, and keeps them there.
 *
 * Most codebases read their secrets as `process.env.SOMETHING` in thirty-six
 * places. Converting every one of them into an async lookup is a risky job for
 * no benefit: it is enough that `process.env` TELLS THE TRUTH. That is all this
 * does — at startup, then on a timer.
 *
 * Three cases, and the third is the one everybody forgets:
 *
 *   the store has a value      → it replaces the one from the environment;
 *   the store says "unplugged" → the variable is DELETED, the env does not return;
 *   the store says nothing     → the ORIGINAL environment value is restored.
 *
 * Without the third, deleting a key would leave the old value frozen in
 * `process.env` until the next restart — a service you believe is unplugged and
 * that keeps working.
 */
const { createPermissiveGuard } = require('./valueGuard');

const NOOP_LOGGER = { warn() {} };

/**
 * @param {object} options
 * @param {object} options.vault    from createCredentialVault().
 * @param {object} [options.guard]  from createValueGuard(). Permissive by default.
 * @param {object} [options.env]    defaults to process.env.
 * @param {object} [options.logger] { warn }.
 */
function createEnvHydrator(options = {}) {
  const vault = options.vault;
  if (!vault || typeof vault.stored !== 'function') {
    throw new Error('createEnvHydrator requires options.vault from createCredentialVault().');
  }
  const guard = options.guard || createPermissiveGuard();
  const env = options.env || process.env;
  const logger = options.logger || NOOP_LOGGER;

  /* What the environment said BEFORE any intervention. Captured once: after
     the first hydration, `process.env` no longer remembers where it started. */
  let original = null;

  /** Fills the environment from the store. Never throws. */
  async function hydrate(keys) {
    const names = Array.isArray(keys) ? keys : [];
    if (!names.length) return { applied: 0, removed: 0, restored: 0 };

    if (!original) {
      original = new Map(names.map((name) => [name, env[name]]));
    } else {
      /* A later call may cover keys the first one did not. Remember those too,
         or restoring them would put back `undefined` instead of their value. */
      for (const name of names) {
        if (!original.has(name)) original.set(name, env[name]);
      }
    }

    let applied = 0;
    let removed = 0;
    let restored = 0;

    try {
      const stored = await vault.stored();
      const decidingValue = guard.decidingKey ? stored.get(guard.decidingKey) : undefined;

      for (const name of names) {
        /* The guard is checked HERE rather than in the caller — a caller can
           forget, and a forgotten guard means a live key on a laptop. */
        if (!guard.mayRead(name, { value: stored.get(name), decidingValue })) continue;

        if (!stored.has(name)) {
          const before = original.get(name);
          if (env[name] !== before) {
            if (before === undefined) delete env[name];
            else env[name] = before;
            restored += 1;
          }
          continue;
        }

        const value = stored.get(name);
        if (value === null) {
          if (env[name] !== undefined) {
            delete env[name];
            removed += 1;
          }
          continue;
        }

        if (env[name] !== value) {
          env[name] = value;
          applied += 1;
        }
      }
    } catch (error) {
      /* Store unreachable: the environment keeps what it has. A payment must
         not fail because reading the keys hiccuped. */
      logger.warn(`[credentials] hydration skipped: ${error.message}`);
    }

    return { applied, removed, restored };
  }

  /**
   * Keeps the environment up to date without a restart.
   * @returns {Function} call it to stop — useful in tests.
   */
  function startRefresh(keys, refreshOptions = {}) {
    const intervalMs = refreshOptions.intervalMs || 60_000;
    const onChange = refreshOptions.onChange;

    const timer = setInterval(async () => {
      const result = await hydrate(keys);
      if (onChange && (result.applied || result.removed || result.restored)) onChange(result);
    }, intervalMs);

    /* This timer must never be the reason a process refuses to exit. */
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  /** Forget the captured originals — tests start from a blank page. */
  function reset() {
    original = null;
  }

  return { hydrate, startRefresh, reset };
}

module.exports = { createEnvHydrator };
