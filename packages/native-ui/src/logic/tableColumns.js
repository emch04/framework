/**
 * Column widths for a table in an AI answer — the rule, dry.
 *
 * THE DEFECT. The table was rendered in a horizontal scroll, but each cell was
 * free text in a row, WITHOUT a column width. React Native then shares the
 * room according to the content of EACH ROW: the header and its rows do not
 * line up, "Subscription" breaks, values float. The table is no longer a
 * table — it is three lists side by side that don't talk to each other.
 *
 * THE RULE. A column has ONE width, computed once for the whole table from its
 * longest content — header included, since the header is what was breaking.
 * The measure is in characters: with no access to the text engine, a
 * character's width is approximated by the font's average width at the size
 * used. An assumed approximation, because the error it makes (a column a bit
 * wide) is invisible, while the error before (misaligned columns) jumped out.
 *
 * WHY A FLOOR ON THE LONGEST WORD. A column narrower than its longest word
 * cuts that word in the middle — "Subscrip- / tion". The floor prevents it: a
 * whole word always fits, and wrapping only happens between two words.
 *
 * WHY A CEILING. Without one, a whole sentence in a cell pushes the column to
 * 600 points and the horizontal scroll never ends. Above the ceiling the text
 * wraps in a taller cell — the row grows, the alignment holds.
 *
 * WHY THE ROUNDING IS INJECTED. A width must land on the screen's pixel grid,
 * or the separating hairline renders as two blurry greys. `PixelRatio` only
 * exists in the app; here the rounding function is received, and a test
 * swaps in the one of a chosen density.
 *
 * MEASURE THE VISIBLE TEXT. Cells go through the inline Markdown renderer
 * ("**Starter**" is shown bold, without its stars), so the caller measures
 * `inlinesToText(parseInline(cell))`, not the raw source.
 */

const DEFAULTS = Object.freeze({
  /* MEASURED TOO NARROW. These were 6.4 and 6.9: at the real size of the cells
     (13.5) and headers (11, uppercase, letter-spaced), a digit takes more.
     "17/09/2026" fell into a column too short and broke into "17/09/202"
     then "6". Measure wide: a column one point too wide doesn't show, a word
     cut in two does. */
  charWidth: 7.4,
  /* THE HEADER IS SHOWN IN SPACED CAPITALS. Measured like the body, "STATUS"
     fell into a column too short and broke into "STATU / S": a capital is
     wider than an average lowercase letter, and letter-spacing adds to it. */
  headerCharWidth: 8.6,
  /* THE REAL PADDING, NOT AN OLD ONE. This margin was 20 — EXACTLY the cell
     padding of the time (10 left, 10 right). Not one pixel was left for
     rounding, and "Number" broke into "Numbe / r". A floor exact to the pixel
     is not a floor. It follows the current padding (12 + 12). */
  padding: 24,
  minWidth: 58,
  maxWidth: 176,
  targetWidth: 0
});

/* A number, an amount, a percentage, a mark out of twenty: what reads
   right-aligned, because the eye then compares units with units. Thousands
   separators and decimal commas are allowed, and any currency symbol (\p{Sc})
   before or after. */
const NUMERIC_VALUE = /^[\p{Sc}+\-−]?\s?\d[\d\s.,/]*\s?(?:%|\p{Sc}|\/\s?\d+)?$/u;

function isNumeric(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return NUMERIC_VALUE.test(text);
}

/** The longest word of a cell, in characters (code points, not UTF-16 units). */
function longestWord(text) {
  return text
    .trim()
    .split(/\s+/)
    .reduce((longest, word) => Math.max(longest, [...word].length), 0);
}

function lengthOf(text) {
  return [...text.trim()].length;
}

/**
 * @param {string[]} header
 * @param {string[][]} rows
 * @param {object} [options]  charWidth, headerCharWidth, padding, minWidth,
 *   maxWidth, targetWidth, fontScale, round.
 * @returns {{widths: number[], numeric: boolean[], totalWidth: number}}
 */
function measureColumns(header, rows, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const round = typeof options.round === 'function' ? options.round : (value) => value;
  /* THE PHONE'S TEXT SIZE. Text grows with the size chosen in the phone's
     settings; the columns must grow too, or a phone set to large text cuts
     every header. Character widths follow it, the padding does not. A
     smaller setting never shrinks below the normal measure. */
  const scale = Math.max(1, options.fontScale ?? 1);
  const charWidth = o.charWidth * scale;
  const headerCharWidth = o.headerCharWidth * scale;

  /* The column count comes from the fullest row, not just the header: a
     model sometimes writes a row longer than its header, and a cell with no
     column disappeared silently. */
  const columnCount = Math.max(header.length, ...rows.map((row) => row.length), 0);

  const widths = [];
  const numeric = [];

  for (let column = 0; column < columnCount; column += 1) {
    const title = header[column] ?? '';
    const cells = rows.map((row) => row[column] ?? '');

    /* Wanted width: the longest content, header included. */
    const wantedBody = Math.max(0, ...cells.map(lengthOf)) * charWidth;
    const wantedHeader = lengthOf(title) * headerCharWidth;
    const wanted = Math.max(wantedBody, wantedHeader) + o.padding;

    /* Floor: the longest word must fit whole, even past the ceiling. */
    const wordFloor =
      Math.max(longestWord(title) * headerCharWidth, ...cells.map((cell) => longestWord(cell) * charWidth), 0) +
      o.padding;

    const bounded = Math.min(Math.max(wanted, o.minWidth), o.maxWidth);
    widths.push(round(Math.max(bounded, wordFloor)));

    /* Numeric only if it has values and ALL are numbers. One text value —
       "unpaid" among amounts — and the column is text again: mixed alignment
       reads worse than a uniform left alignment. */
    const filled = cells.filter((cell) => cell.trim().length > 0);
    numeric.push(filled.length > 0 && filled.every(isNumeric));
  }

  /* Stretch to the target width, proportionally: every column grows by the
     same percentage, so the width ratios — and the reading — don't change.
     The old `minWidth: 300` on the frame widened the border but not the
     columns, leaving a gap on the right. The rounding remainder goes to the
     widest column, the only one where one more point doesn't show. */
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (o.targetWidth > total && total > 0) {
    const factor = o.targetWidth / total;
    for (let i = 0; i < widths.length; i += 1) widths[i] = round(widths[i] * factor);
    const missing = o.targetWidth - widths.reduce((sum, width) => sum + width, 0);
    if (missing > 0) {
      const widest = widths.indexOf(Math.max(...widths));
      widths[widest] = round(widths[widest] + missing);
    }
  }

  return { widths, numeric, totalWidth: widths.reduce((sum, width) => sum + width, 0) };
}

module.exports = { TABLE_COLUMN_DEFAULTS: DEFAULTS, isNumeric, measureColumns };
