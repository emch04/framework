/**
 * Password rules, said once — and said per condition.
 *
 * The usual shape is one regex, copied into the signup screen and enforced
 * blindly by the server. The user sees a single line — "8 characters min…" —
 * and only finds out WHICH of the five conditions failed when the form
 * bounces. Worse, the two copies drift, and a password the screen accepts
 * fails on the server.
 *
 * Here each condition is evaluated separately, so a screen can tick them off
 * as the person types — and the same module runs on the server, so the two
 * ends cannot disagree. It has no dependencies for exactly that reason.
 */

const DEFAULT_CONDITIONS = [
  { key: 'length', test: (value, { minLength }) => value.length >= minLength },
  { key: 'lowercase', test: (value) => /[a-z]/.test(value) },
  { key: 'uppercase', test: (value) => /[A-Z]/.test(value) },
  { key: 'digit', test: (value) => /\d/.test(value) },
  { key: 'special', test: (value) => /[^A-Za-z\d]/.test(value) }
];

/**
 * @param {object} [options]
 * @param {number} [options.minLength] default 8.
 * @param {Array}  [options.conditions] replaces the defaults: [{ key, test }].
 *   Keys, not sentences: the screen translates them, the rule does not carry
 *   a language.
 */
function createPasswordRules(options = {}) {
  const minLength = options.minLength || 8;
  const conditions = options.conditions || DEFAULT_CONDITIONS;
  if (!Array.isArray(conditions) || !conditions.length) {
    throw new Error('createPasswordRules requires at least one condition.');
  }

  const context = { minLength };

  /** Every condition, each saying whether it is met — for live feedback. */
  function check(password) {
    const value = typeof password === 'string' ? password : '';
    return conditions.map(({ key, test }) => ({ key, met: Boolean(test(value, context)) }));
  }

  function isValid(password) {
    return check(password).every((condition) => condition.met);
  }

  /** Share of conditions met, 0..1 — feeds a progress bar directly. */
  function strength(password) {
    const checks = check(password);
    return checks.filter((condition) => condition.met).length / checks.length;
  }

  /**
   * May the form be submitted? Valid AND confirmed — separated from any
   * screen so the button's condition is testable on its own.
   */
  function canSubmit(password, confirmation) {
    return isValid(password) && password === confirmation;
  }

  return { check, isValid, strength, canSubmit, minLength, keys: conditions.map((c) => c.key) };
}

module.exports = { createPasswordRules };
