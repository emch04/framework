/**
 * Telling the model where its reply will be displayed.
 *
 * The same answer goes to a 1,400-pixel desktop console and to a 390-point
 * phone. A model that is not told writes for the screen it imagines, and ships
 * five-column tables that a phone renders as crushed columns or a horizontal
 * scroll nobody finds.
 *
 * Why the default surface is the PHONE: guessing small wrongly costs a list
 * where a table would have fit — still readable. Guessing large wrongly costs an
 * unreadable table on the phone. The risk is not symmetric.
 *
 * Why the paragraph rule is mandatory: without it models start a sentence and
 * leave it hanging, or pack a compact block with no breathing room, and put
 * horizontal rules (---) between ideas. The rule must reach EVERY surface — so a
 * language pack without it is refused at creation, not discovered on a screen.
 *
 * All wording is supplied by the caller, per language. Templates may use
 * {surface} (that language's name for the surface) and {columns}.
 */

const DEFAULT_SURFACES = {
  phone: { columns: 3, narrow: true, aliases: ['mobile', 'ios', 'android'] },
  tablet: { columns: 4, narrow: false, aliases: ['ipad'] },
  desktop: { columns: 6, narrow: false, aliases: ['web', 'browser'] }
};

function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
  ));
}

/**
 * @param {object} options
 * @param {Record<string, object>} options.languages  language -> pack:
 *   { paragraphs (required), heading?, intro?, table?, narrow?, wide?,
 *     rules?: string[], surfaceNames?: Record<surfaceId, string> }
 * @param {Record<string, {columns: number, narrow?: boolean, aliases?: string[]}>} [options.surfaces]
 * @param {string} [options.defaultSurface='phone']
 * @param {string} [options.fallbackLanguage]
 */
function createFormatInstructions(options = {}) {
  const surfaces = options.surfaces || DEFAULT_SURFACES;
  const defaultSurface = options.defaultSurface || 'phone';
  if (!surfaces[defaultSurface]) {
    throw new Error(`createFormatInstructions: unknown defaultSurface "${defaultSurface}".`);
  }
  const languages = options.languages || {};
  const names = Object.keys(languages);
  if (!names.length) throw new Error('createFormatInstructions requires at least one language pack.');
  for (const name of names) {
    const pack = languages[name];
    if (!pack || typeof pack.paragraphs !== 'string' || !pack.paragraphs.trim()) {
      throw new Error(`createFormatInstructions: language "${name}" has no paragraphs rule.`);
    }
  }
  const fallbackLanguage = options.fallbackLanguage && languages[options.fallbackLanguage]
    ? options.fallbackLanguage
    : names[0];

  const aliasIndex = new Map();
  for (const [id, surface] of Object.entries(surfaces)) {
    aliasIndex.set(id.toLowerCase(), id);
    for (const alias of surface.aliases || []) aliasIndex.set(String(alias).toLowerCase(), id);
  }

  /** Any client-sent value maps to a known surface; missing or unknown means the default. */
  function normalizeSurface(value) {
    if (typeof value !== 'string') return defaultSurface;
    return aliasIndex.get(value.trim().toLowerCase()) || defaultSurface;
  }

  function build(surfaceValue, language) {
    const id = normalizeSurface(surfaceValue);
    const surface = surfaces[id];
    const pack = languages[language] || languages[fallbackLanguage];
    const values = {
      surface: (pack.surfaceNames && pack.surfaceNames[id]) || id,
      columns: surface.columns
    };

    const lines = [];
    if (pack.intro) lines.push(fill(pack.intro, values));
    const bullets = [];
    if (pack.table) bullets.push(pack.table);
    const sizeRule = surface.narrow ? pack.narrow : pack.wide;
    if (sizeRule) bullets.push(sizeRule);
    bullets.push(pack.paragraphs);
    for (const rule of pack.rules || []) bullets.push(rule);
    lines.push(bullets.map((b) => `- ${fill(b, values)}`).join('\n'));

    return (pack.heading ? `${fill(pack.heading, values)}\n` : '') + lines.join('\n\n');
  }

  return { build, normalizeSurface, surfaces: Object.keys(surfaces), languages: names };
}

module.exports = { createFormatInstructions, DEFAULT_SURFACES };
