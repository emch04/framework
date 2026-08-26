/**
 * Writing to support, with what support would have had to ask for.
 *
 * The help button used to open a bare `mailto:`. Two things followed from
 * that, both costing a round trip:
 *
 *   the message arrived EMPTY. Support received "it does not work" with no
 *   idea who was writing, in which role, on which version — the first reply
 *   was spent asking for what the app already knew;
 *
 *   an accent or a newline TRUNCATED the message in some mail clients, so the
 *   half that mattered never arrived. Subject and body are encoded here.
 *
 * The labels are passed in, never built in: this module carries no language.
 */

const DEFAULT_FIELDS = [
  { key: 'name', label: 'Nom' },
  { key: 'role', label: 'Rôle' },
  { key: 'appVersion', label: 'Version' },
  { key: 'platform', label: 'Appareil' }
];

function clean(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

/**
 * @param {object} options
 * @param {string} options.email  Where support reads its mail.
 * @param {Array<{key: string, label: string}>} [options.fields]  What to attach,
 *   in the order it should be read.
 * @param {string} [options.separator='—']
 */
function createSupportLink(options = {}) {
  const email = clean(options.email);
  if (!email) throw new Error('createSupportLink requires options.email.');
  const fields = Array.isArray(options.fields) && options.fields.length ? options.fields : DEFAULT_FIELDS;
  const separator = options.separator || '—';

  /**
   * The signature block. Absent facts are dropped: a line reading "Version :"
   * with nothing after it tells support less than no line at all.
   * @param {object} [context]  Values by field key.
   * @param {object} [labels]  Overrides by field key, plus `separator`.
   */
  function body(context = {}, labels = {}) {
    const rows = fields
      .map((field) => [labels[field.key] || field.label, clean(context[field.key])])
      .filter(([, value]) => value.length > 0);
    if (!rows.length) return '';
    const rule = labels.separator || separator;
    return `\n\n${rule}\n${rows.map(([label, value]) => `${label} : ${value}`).join('\n')}`;
  }

  /** The complete link. Everything encoded, empty parts left out. */
  function mailto(subject, text = '', address = email) {
    const params = [`subject=${encodeURIComponent(clean(subject))}`];
    if (clean(text)) params.push(`body=${encodeURIComponent(text)}`);
    return `mailto:${address}?${params.join('&')}`;
  }

  return { email, body, mailto };
}

module.exports = { createSupportLink };
