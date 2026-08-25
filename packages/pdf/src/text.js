/**
 * Text that stays inside its box.
 *
 * PDFKit, given an absolute position and no width, lets a string run to the
 * edge of the page and then wraps it — and the next line lands on top of
 * whatever was drawn below. That is how a long school name ends up under the
 * title band, and a long product label on top of the price column.
 *
 * Giving it a width does not solve it either: as of 0.18, PDFKit ignores
 * `lineBreak: false` the moment a width is supplied, wraps anyway, and its
 * `ellipsis` option never fires. So the truncation is done here, by hand.
 *
 * Nothing in this package imports PDFKit. You pass the document in, which keeps
 * the package dependency-free and works with any object exposing the same
 * `text` / `heightOfString` surface.
 */

/**
 * Shorten `text` until it fits `width` on ONE line, ellipsis included.
 *
 * Measured with the ACTIVE font, so call it after `font()` / `fontSize()`.
 *
 * The measurement uses HEIGHT, not `widthOfString`. PDFKit's wrapper
 * accumulates width word by word and will break a line that fits by a fraction
 * of a point under whole-string measurement. "Does it still occupy one line?"
 * is the only question whose answer matches what actually gets drawn — and it
 * holds across PDFKit versions.
 */
function fitText(doc, text, width) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || !(width > 0)) return '';

  const oneLine = doc.heightOfString('A', { width });
  const fits = (candidate) => doc.heightOfString(candidate, { width }) <= oneLine;
  if (fits(raw)) return raw;

  /* Binary search on the cut point: a linear walk is O(n) calls into the font
     metrics, and these documents have hundreds of cells. */
  let low = 0;
  let high = raw.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(`${raw.slice(0, mid).trimEnd()}…`)) low = mid;
    else high = mid - 1;
  }

  return low > 0 ? `${raw.slice(0, low).trimEnd()}…` : '';
}

/**
 * Draw one line of text, bounded and truncated.
 *
 * Use this wherever a value comes from data you do not control — a name, a
 * label, an address. Bounded and cut, a value can no longer bite into its
 * neighbour.
 */
function line(doc, text, x, y, width, options = {}) {
  return doc.text(fitText(doc, text, width), x, y, { width, lineBreak: false, ...options });
}

/**
 * How tall wrapped text will be at this width.
 *
 * For rows that must grow to fit their content: a long comment is information,
 * and cutting it would lose it. Contrast with `line`, for values that must not
 * grow.
 */
function blockHeight(doc, text, width, options = {}) {
  return doc.heightOfString(String(text ?? ''), { width, ...options });
}

module.exports = { fitText, line, blockHeight };
