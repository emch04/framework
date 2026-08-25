/**
 * The right to erasure — which is almost never a deletion.
 *
 * Deleting the row is the obvious move and usually the wrong one. A student's
 * grades, a customer's invoices, an employee's payroll entries: those records
 * have their own legal retention, and they belong to the school, the company,
 * the tax authority as much as to the person. Deleting the account row either
 * takes them with it or leaves them orphaned and unexplainable.
 *
 * What the law asks for is that the person stop being IDENTIFIABLE. So the
 * identifying fields go, the rest stays, and the records remain coherent.
 *
 * This is irreversible by design. There is no undo, and there should not be —
 * an anonymisation you can reverse has not anonymised anything.
 */
const crypto = require('crypto');

/** A collision here would merge two people. Eight random bytes is plenty. */
const defaultToken = () => crypto.randomBytes(8).toString('hex');

/**
 * @param {object} options
 * @param {Record<string, *>} options.fields  field name -> what to do:
 *   'clear'        remove the value;
 *   'redact'       replace with a fixed placeholder;
 *   a string       use it as the literal replacement;
 *   a function     (value, ctx) => newValue, with ctx = { token, field }.
 * @param {string} [options.placeholder]  used by 'redact'. Default 'Anonymised'.
 * @param {Function} [options.token]      () => string, the unique marker.
 * @param {Function} [options.has]        (record, field) => boolean. Defaults to
 *   a plain property check; pass a schema-aware one to avoid inventing fields.
 * @param {Function} [options.onAnonymised] async (record, ctx) => void, for
 *   what a field rewrite cannot express — invalidating sessions, dropping
 *   push subscriptions, revoking tokens.
 */
function createAnonymizer(options = {}) {
  const fields = options.fields || {};
  if (!Object.keys(fields).length) {
    throw new Error('createAnonymizer requires at least one field in options.fields.');
  }

  const placeholder = options.placeholder || 'Anonymised';
  const token = options.token || defaultToken;
  const has = options.has || ((record, field) => record !== null && typeof record === 'object' && field in record);
  const onAnonymised = options.onAnonymised || null;

  function valueFor(rule, current, context) {
    if (typeof rule === 'function') return rule(current, context);
    if (rule === 'clear') return undefined;
    if (rule === 'redact') return placeholder;
    return rule;
  }

  /**
   * Rewrite the identifying fields on `record`, in place.
   *
   * Does NOT save: persistence is yours, and a save inside here would decide
   * transaction boundaries on your behalf.
   *
   * @returns {{token: string, changed: string[], skipped: string[]}}
   */
  async function anonymise(record, extra = {}) {
    if (!record || typeof record !== 'object') {
      throw new Error('anonymise requires a record object.');
    }

    const marker = token();
    const changed = [];
    const skipped = [];

    for (const [field, rule] of Object.entries(fields)) {
      /* A field the record does not carry is skipped, not invented. Adding
         `parentPhone` to an employee record would be a new piece of personal
         data created by the erasure itself. */
      if (!has(record, field)) {
        skipped.push(field);
        continue;
      }
      record[field] = valueFor(rule, record[field], { token: marker, field, record });
      changed.push(field);
    }

    if (onAnonymised) await onAnonymised(record, { token: marker, changed, ...extra });

    return { token: marker, changed, skipped };
  }

  return { anonymise, fields: Object.keys(fields) };
}

module.exports = { createAnonymizer, defaultToken };
