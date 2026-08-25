/**
 * The right of access: give people what you hold on them.
 *
 * The part everyone gets wrong is not the export — it is the SILENCE around it.
 * A product spread over three services exports what the first one holds and
 * says nothing about the other two, so the person receives a file that looks
 * complete and is not. That is a compliance failure dressed as a feature.
 *
 * So a source can declare that it lives elsewhere. The export then names the
 * gap instead of hiding it.
 */

/**
 * @param {object} options
 * @param {Array} options.sources  each one:
 *   { key, label?, collect?: async (subject) => data, elsewhere?: string }
 *   `elsewhere` marks data this service does not hold — the string says where
 *   it lives and how to ask for it.
 * @param {object} [options.logger]
 */
function createDataExporter(options = {}) {
  const sources = options.sources || [];
  if (!sources.length) {
    throw new Error('createDataExporter requires at least one source.');
  }

  for (const source of sources) {
    if (!source || typeof source.key !== 'string' || !source.key.trim()) {
      throw new Error('createDataExporter requires every source to have a key.');
    }
    if (typeof source.collect !== 'function' && !source.elsewhere) {
      throw new Error(`createDataExporter: source "${source.key}" needs either collect() or elsewhere.`);
    }
  }

  const logger = options.logger || { error() {} };

  /**
   * @param {*} subject whatever identifies the person — an id, a record.
   * @returns {Promise<object>} the file you hand over.
   */
  async function exportFor(subject) {
    const sections = {};
    const heldElsewhere = [];
    const failed = [];

    for (const source of sources) {
      if (source.elsewhere) {
        heldElsewhere.push({ key: source.key, label: source.label || source.key, where: source.elsewhere });
        continue;
      }
      try {
        sections[source.key] = await source.collect(subject);
      } catch (error) {
        /* One unreachable source must not sink the whole export — but it must
           be NAMED. An export silently missing a section is worse than one
           that says which part could not be produced. */
        logger.error(`[privacy] export source "${source.key}" failed: ${error.message}`);
        failed.push({ key: source.key, label: source.label || source.key, reason: error.message });
      }
    }

    return {
      exportedAt: new Date().toISOString(),
      sections,
      /* Both lists are part of the answer, not metadata. */
      notIncluded: heldElsewhere,
      unavailable: failed,
      complete: failed.length === 0 && heldElsewhere.length === 0
    };
  }

  return { export: exportFor, sources: sources.map((source) => source.key) };
}

module.exports = { createDataExporter };
