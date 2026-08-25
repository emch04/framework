/**
 * Deciding where a page ends.
 *
 * PDFKit adds pages on its own when text overflows, which is exactly wrong for
 * a laid-out document: the break lands mid-row, or leaves a summary block
 * stranded at the very bottom, or starts a fresh page for two lines of
 * signature. Page breaks belong to whoever knows what must stay together.
 */

/** Where the usable area of a page ends by default. */
function defaultBottom(doc, reserve = 40) {
  return doc.page.height - reserve;
}

/**
 * Make room for a block that must NOT be split.
 *
 * A summary panel, a signature line, a total: half of it at the bottom of one
 * page and half at the top of the next is worse than a page break before it.
 *
 * @returns {number} the y to draw at — unchanged, or the top of a fresh page.
 */
function keepTogether(doc, options = {}) {
  const y = options.y;
  const height = options.height;
  if (typeof y !== 'number' || typeof height !== 'number') {
    throw new Error('keepTogether requires numeric options.y and options.height.');
  }

  const bottom = options.bottom === undefined ? defaultBottom(doc) : options.bottom;
  if (y + height <= bottom) return y;

  doc.addPage();
  return options.top === undefined ? doc.page.margins.top : options.top;
}

module.exports = { keepTogether, defaultBottom };
