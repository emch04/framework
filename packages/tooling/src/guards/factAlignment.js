/**
 * What the product SAYS about itself must be what the code DOES.
 *
 * The defect: prices, commission rates and limits get copied into an AI
 * knowledge base, a help page, a sales deck. The code changes; the copy does
 * not. The assistant then quotes a 1 % fee that the ledger charges at 0.5 %,
 * or lists fifteen payment methods when two are wired — confidently, to a
 * paying customer. This compares both sides key by key.
 *
 * The caller extracts: `facts` from the code (a required constant, a regex
 * over a config file), `claims` from the text (a JSON path, a regex over
 * prose). The comparator only decides whether they agree — and refuses to
 * call two failed extractions an agreement.
 */

function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'number' && Number.isNaN(value));
}

function stableKey(value) {
  return JSON.stringify(value, (_key, inner) => (
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
      : inner
  ));
}

function sameValue(fact, claim, options) {
  if (typeof fact === 'number' && typeof claim === 'number') {
    return Math.abs(fact - claim) <= options.tolerance;
  }

  if (Array.isArray(fact) && Array.isArray(claim)) {
    if (fact.length !== claim.length) return false;
    /* Order rarely carries meaning in a list of plans or gateways, and a
       reordered list is not a lie. `arrayOrder: 'strict'` when it does. */
    const left = options.arrayOrder === 'strict' ? fact : [...fact].sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
    const right = options.arrayOrder === 'strict' ? claim : [...claim].sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
    return left.every((item, index) => sameValue(item, right[index], options));
  }

  if (fact && claim && typeof fact === 'object' && typeof claim === 'object') {
    const keys = new Set([...Object.keys(fact), ...Object.keys(claim)]);
    return [...keys].every((key) => sameValue(fact[key], claim[key], options));
  }

  return Object.is(fact, claim);
}

/**
 * @param {object} input
 * @param {Record<string, unknown>} input.facts  key -> value read from the code.
 * @param {Record<string, unknown>} input.claims key -> value read from the text.
 * @param {object} [options]
 * @param {number} [options.tolerance=1e-9] absolute tolerance for numbers
 *   (0.1 + 0.2 must equal 0.3; 0.01 must not equal 0.005).
 * @param {'ignore'|'strict'} [options.arrayOrder='ignore']
 * @param {boolean} [options.requireEveryFact=false] fail when the text is
 *   silent about a fact, not only when it contradicts one.
 */
function compareFacts(input = {}, options = {}) {
  const facts = input.facts || {};
  const claims = input.claims || {};
  const settings = {
    tolerance: options.tolerance ?? 1e-9,
    arrayOrder: options.arrayOrder || 'ignore'
  };

  const mismatches = [];
  const unextracted = [];
  const unbacked = [];
  const unstated = [];

  for (const key of Object.keys(claims)) {
    if (!Object.prototype.hasOwnProperty.call(facts, key)) {
      /* A claim nobody checks against the code is exactly the one that
         drifts. */
      unbacked.push({ key, claim: claims[key] });
      continue;
    }

    const fact = facts[key];
    const claim = claims[key];

    /* A regex that stopped matching returns undefined on BOTH sides the day
       the file is reformatted, and a plain deep-equal calls that agreement.
       A missing value is a broken extractor, never a match. */
    if (isMissing(fact) || isMissing(claim)) {
      unextracted.push({ key, side: isMissing(fact) ? (isMissing(claim) ? 'both' : 'fact') : 'claim', fact, claim });
      continue;
    }

    if (!sameValue(fact, claim, settings)) {
      mismatches.push({ key, fact, claim });
    }
  }

  for (const key of Object.keys(facts)) {
    if (!Object.prototype.hasOwnProperty.call(claims, key)) {
      unstated.push({ key, fact: facts[key] });
    }
  }

  const ok = !mismatches.length && !unextracted.length && !unbacked.length && (!options.requireEveryFact || !unstated.length);
  return { ok, mismatches, unextracted, unbacked, unstated };
}

/**
 * Reads values out of a parsed document by dotted path:
 * `pickPaths(json, { proPrice: 'plans.pro.price' })`.
 * A missing path yields undefined, which compareFacts reports.
 */
function pickPaths(document, paths) {
  const values = {};
  for (const [key, dotted] of Object.entries(paths)) {
    values[key] = String(dotted).split('.').reduce(
      (node, part) => (node === undefined || node === null ? undefined : node[part]),
      document
    );
  }
  return values;
}

/**
 * Reads values out of raw text with one regex per key. Group 1 is taken
 * (group 0 when there is none); a numeric-looking capture becomes a number,
 * because "49" in a config file and 49 in a JSON document are the same fact.
 * Pass `parse` to take over the conversion.
 */
function extractMatches(text, patterns, options = {}) {
  const values = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text);
    if (!match) {
      values[key] = undefined;
      continue;
    }
    const raw = match[1] !== undefined ? match[1] : match[0];
    if (options.parse) {
      values[key] = options.parse(raw, key);
    } else {
      values[key] = /^-?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    }
  }
  return values;
}

function formatFactReport(report) {
  return [
    ...report.mismatches.map((entry) => `${entry.key}: code says ${JSON.stringify(entry.fact)}, text says ${JSON.stringify(entry.claim)}`),
    ...report.unextracted.map((entry) => `${entry.key}: nothing extracted from the ${entry.side === 'both' ? 'code nor the text' : entry.side === 'fact' ? 'code' : 'text'}`),
    ...report.unbacked.map((entry) => `${entry.key}: claimed (${JSON.stringify(entry.claim)}) but no fact read from the code`),
    ...report.unstated.map((entry) => `${entry.key}: in the code (${JSON.stringify(entry.fact)}) but not stated`)
  ].join('\n');
}

/** Throws with every disagreement; returns the report when aligned. */
function assertFactsAligned(input, options = {}) {
  const report = compareFacts(input, options);
  if (!report.ok) {
    throw new Error(`Text and code disagree:\n${formatFactReport(report)}`);
  }
  return report;
}

module.exports = {
  assertFactsAligned,
  compareFacts,
  extractMatches,
  formatFactReport,
  pickPaths
};
