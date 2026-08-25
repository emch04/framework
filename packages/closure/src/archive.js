/**
 * The archive a closed period leaves behind.
 *
 * Two rules, both learned the expensive way:
 *
 *   WHAT NEVER GOES IN. An archive gets handed over, filed, sometimes
 *   emailed. It must never contain what lets someone log in as somebody else:
 *   passwords, tokens, API keys. Scrubbing at the archive boundary — rather
 *   than trusting every reader to have selected its fields — is the only
 *   version that survives the next person adding a collection.
 *
 *   ONE FAILED SECTION DOES NOT EMPTY THE ARCHIVE. Collections are read
 *   separately; a reader that throws is recorded as failed and the rest of the
 *   archive still gets built. The report says exactly what is inside and what
 *   is not — an archive silently missing a section looks complete and is not.
 */

const DEFAULT_NEVER_EXPORT = [
  'password', 'passwordHash', 'refreshToken', 'tokenVersion', 'otp',
  'apiKey', 'secretKey', 'webhookSecret', 'privateKey', 'credential',
  'pushSubscriptions', '__v'
];

/**
 * @param {object} [options]
 * @param {string[]} [options.neverExport] replaces the default list.
 * @param {string[]} [options.alsoNever]   added to it.
 */
function createScrubber(options = {}) {
  const banned = new Set([...(options.neverExport || DEFAULT_NEVER_EXPORT), ...(options.alsoNever || [])]);

  /** Strip the banned fields from one document. Shallow on purpose: archives
      are rows, and a row's secrets live at the top level. Nested payloads you
      built yourself are yours to shape before archiving. */
  function scrub(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
    const clean = {};
    for (const [key, value] of Object.entries(document)) {
      if (banned.has(key)) continue;
      clean[key] = value;
    }
    return clean;
  }

  return { scrub, banned: [...banned] };
}

/**
 * @param {object} options
 * @param {Array} options.sections  [{ name, read: async (scope) => rows }].
 * @param {object} [options.scrubber] from createScrubber(). Default scrubber otherwise.
 * @param {object} [options.logger]
 */
function createArchiveBuilder(options = {}) {
  const sections = options.sections || [];
  if (!sections.length) {
    throw new Error('createArchiveBuilder requires at least one section.');
  }
  for (const section of sections) {
    if (!section || typeof section.name !== 'string' || typeof section.read !== 'function') {
      throw new Error('createArchiveBuilder requires every section to have a name and a read().');
    }
  }

  const scrubber = options.scrubber || createScrubber();
  const logger = options.logger || { error() {} };

  /**
   * @param {*} scope  whatever identifies the period — passed to every reader.
   * @returns {{builtAt: string, sections: object, counts: object, failed: Array, complete: boolean}}
   */
  async function build(scope) {
    const archive = {};
    const counts = {};
    const failed = [];

    for (const section of sections) {
      try {
        const rows = (await section.read(scope)) || [];
        archive[section.name] = rows.map((row) => scrubber.scrub(row));
        counts[section.name] = rows.length;
      } catch (error) {
        logger.error(`[closure] section "${section.name}" failed: ${error.message}`);
        failed.push({ name: section.name, reason: error.message });
      }
    }

    return {
      builtAt: new Date().toISOString(),
      sections: archive,
      counts,
      failed,
      complete: failed.length === 0
    };
  }

  return { build, sections: sections.map((section) => section.name) };
}

module.exports = { createArchiveBuilder, createScrubber, DEFAULT_NEVER_EXPORT };
