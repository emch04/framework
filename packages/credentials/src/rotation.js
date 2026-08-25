/**
 * Changing the cipher without losing what it protects.
 *
 * The failure this exists to prevent is quiet. Swap the encryption key and
 * nothing throws: the vault catches a failed decrypt per row, falls back to the
 * environment, and every stored key simply stops being used. Payments go
 * through the old .env value, or stop going through at all. You find out from
 * a customer, not from a log.
 *
 * So a rotation is three moves, and the middle one is the whole point:
 *
 *   1. hand the vault BOTH ciphers — new as `cipher`, old as `previousCipher`.
 *      Nothing has moved yet, and nothing is broken;
 *   2. run this: every value readable with the old cipher is rewritten with
 *      the new one, in place, one at a time;
 *   3. once `plan()` reports nothing left and nothing unreadable, drop
 *      `previousCipher`.
 *
 * Never skip step 3's check. A value neither cipher can read is already lost,
 * and dropping the old cipher is what makes that permanent.
 *
 * Every operation is idempotent: a value already carrying the new generation is
 * recognised and left alone, so an interrupted run is simply re-run.
 */
const { assertAdapter } = require('./utils');

const DISCONNECTED = '__disconnected__';
const MAX_SAMPLES = 10;

/**
 * @param {object} options
 * @param {object} options.store    credential store adapter (findAll, upsert).
 * @param {object} options.catalog  from createCredentialCatalog().
 * @param {object} options.to       the cipher to migrate TO. Needs encrypt+decrypt.
 * @param {object} options.from     the cipher being retired. Needs decrypt.
 * @param {object} [options.logger] { warn, error }.
 */
function createCredentialRotation(options = {}) {
  const store = options.store;
  assertAdapter(store, ['findAll', 'upsert'], 'options.store');

  const catalog = options.catalog;
  if (!catalog || typeof catalog.isSecret !== 'function') {
    throw new Error('createCredentialRotation requires options.catalog from createCredentialCatalog().');
  }

  const to = options.to;
  if (!to || typeof to.encrypt !== 'function' || typeof to.decrypt !== 'function') {
    throw new Error('createCredentialRotation requires options.to with encrypt() and decrypt().');
  }

  const from = options.from;
  if (!from || typeof from.decrypt !== 'function') {
    throw new Error('createCredentialRotation requires options.from with decrypt().');
  }

  const logger = options.logger || { warn() {}, error() {} };

  /**
   * What should happen to one stored row.
   *
   * The new cipher is tried FIRST. A value already migrated is then recognised
   * as such instead of being reported unreadable — which is what makes the run
   * safe to repeat.
   *
   * @returns {{status: "rotated"|"already"|"plain"|"skipped"|"unreadable", value?: string}}
   */
  function decide(row) {
    if (!row || row.value === null || row.value === undefined || row.value === '') return { status: 'skipped' };
    /* A disconnect marker is not ciphertext. Rewriting it would turn a key
       that is deliberately unplugged into one that is merely unreadable. */
    if (row.value === DISCONNECTED) return { status: 'skipped' };
    /* A value declared not-secret is stored in the clear on purpose — a public
       client id has to stay readable in the interface. */
    if (!catalog.isSecret(row.key)) return { status: 'plain' };

    try {
      to.decrypt(row.value);
      return { status: 'already' };
    } catch {
      /* Not migrated yet — the normal case. */
    }

    try {
      return { status: 'rotated', value: to.encrypt(from.decrypt(row.value)) };
    } catch {
      /* Neither generation reads it. We do not guess, and we do not overwrite. */
    }

    return { status: 'unreadable' };
  }

  async function walk(apply) {
    const report = {
      apply,
      scanned: 0,
      rotated: 0,
      already: 0,
      plain: 0,
      skipped: 0,
      unreadable: 0,
      written: 0,
      unreadableKeys: []
    };

    let rows;
    try {
      rows = (await store.findAll()) || [];
    } catch (error) {
      logger.warn(`[credentials] rotation could not read the store: ${error.message}`);
      throw error;
    }

    for (const row of rows) {
      report.scanned += 1;
      const decision = decide(row);
      report[decision.status] += 1;

      if (decision.status === 'unreadable' && report.unreadableKeys.length < MAX_SAMPLES) {
        report.unreadableKeys.push(row.key);
      }

      if (decision.status === 'rotated' && apply) {
        await store.upsert({
          key: row.key,
          value: decision.value,
          secret: true,
          updatedBy: row.updatedBy || null,
          updatedAt: new Date()
        });
        report.written += 1;
      }
    }

    return report;
  }

  return {
    /** Read-only: what a rotation WOULD do. Writes nothing. */
    plan: () => walk(false),

    /** Rewrite every value the retiring cipher can still read. */
    apply: () => walk(true),

    /**
     * May the retiring cipher be dropped?
     *
     * The only question that matters at the end, and the one worth answering
     * out loud: nothing left to migrate, and nothing that neither cipher reads.
     */
    async isComplete() {
      const report = await walk(false);
      return {
        complete: report.rotated === 0 && report.unreadable === 0,
        pending: report.rotated,
        unreadable: report.unreadable,
        unreadableKeys: report.unreadableKeys
      };
    },

    decide
  };
}

module.exports = { createCredentialRotation };
