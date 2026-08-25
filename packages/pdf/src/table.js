/**
 * A table that paginates without splitting a row.
 *
 * Three behaviours, each learned the hard way:
 *
 *   the header repeats on every page — otherwise page two is a wall of
 *     unlabelled numbers;
 *   a row's height follows its tallest cell — a long comment is information,
 *     and truncating it would lose it;
 *   a row never straddles a page break — half a row at the bottom and half at
 *     the top reads as two different rows.
 *
 * `bottom` is the other half of that last rule: it reserves the space for
 * whatever comes AFTER the table. Without it, a totals block gets pushed onto
 * a page of its own, or worse, onto the footer.
 */
const { fitText, blockHeight } = require('./text');
const { defaultBottom } = require('./flow');

const DEFAULTS = {
  minRowHeight: 20,
  padding: 12,
  cellPadding: 5,
  headerFill: '#F0F0F0',
  headerStroke: '#000000',
  rowStroke: '#DDDDDD',
  zebra: null,
  fontSize: 8,
  headerFontSize: 8,
  font: 'Helvetica',
  headerFont: 'Helvetica-Bold',
  color: '#000000'
};

function normalizeColumns(columns, width) {
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error('drawTable requires a non-empty options.columns.');
  }

  const declared = columns.reduce((sum, column) => sum + (column.width || 0), 0);
  const missing = columns.filter((column) => !column.width);

  /* Columns without a width share what is left. Declaring every width by hand
     is how a table stops adding up to its own frame after one edit. */
  const share = missing.length ? Math.max(0, width - declared) / missing.length : 0;

  let cursor = 0;
  return columns.map((column) => {
    const columnWidth = column.width || share;
    const normalized = {
      key: column.key,
      label: column.label === undefined ? column.key : column.label,
      width: columnWidth,
      offset: cursor,
      align: column.align || 'left',
      /* `wrap: true` lets a cell grow the row. Everything else is truncated,
         because a value that grows silently is a value that overlaps. */
      wrap: Boolean(column.wrap),
      fontSize: column.fontSize,
      format: column.format
    };
    cursor += columnWidth;
    return normalized;
  });
}

function cellText(column, row) {
  const raw = column.format ? column.format(row[column.key], row) : row[column.key];
  return raw === null || raw === undefined ? '' : String(raw);
}

/**
 * @param {object} doc     a PDFKit document.
 * @param {object} options
 * @param {Array}  options.columns  [{ key, label, width?, align?, wrap?, format? }]
 * @param {Array}  options.rows
 * @param {number} options.x
 * @param {number} options.y        where the table starts.
 * @param {number} options.width
 * @param {number} [options.bottom] y past which a new page begins. Defaults to
 *   the page height less 40pt — raise it to reserve room for a totals block.
 * @param {number} [options.top]    y to resume at on a new page.
 * @param {Function} [options.onNewPage] (doc) => void, before the header redraws.
 * @returns {{y: number, pages: number, rows: number}} where the cursor ended up.
 */
function drawTable(doc, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const { x, y, width } = settings;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number') {
    throw new Error('drawTable requires numeric options.x, options.y and options.width.');
  }

  const columns = normalizeColumns(settings.columns, width);
  const rows = settings.rows || [];
  const bottom = settings.bottom === undefined ? defaultBottom(doc) : settings.bottom;
  const top = settings.top === undefined ? doc.page.margins.top : settings.top;
  const pad = settings.cellPadding;

  let cursorY = y;
  let pages = 1;

  const drawHeader = () => {
    doc.font(settings.headerFont).fontSize(settings.headerFontSize);
    doc.rect(x, cursorY, width, settings.minRowHeight).fill(settings.headerFill).stroke(settings.headerStroke);
    doc.fillColor(settings.color);
    for (const column of columns) {
      doc.text(
        fitText(doc, column.label, column.width - pad * 2),
        x + column.offset + pad,
        cursorY + pad / 2 + 2,
        { width: column.width - pad * 2, align: column.align, lineBreak: false }
      );
    }
    cursorY += settings.minRowHeight;
  };

  drawHeader();

  rows.forEach((row, index) => {
    doc.font(settings.font);

    /* Measure BEFORE drawing anything: the row's height decides whether it
       fits on this page at all, and a row half-drawn cannot be taken back. */
    let contentHeight = 0;
    for (const column of columns) {
      if (!column.wrap) continue;
      doc.fontSize(column.fontSize || settings.fontSize);
      contentHeight = Math.max(contentHeight, blockHeight(doc, cellText(column, row), column.width - pad * 2));
    }
    const rowHeight = Math.max(settings.minRowHeight, contentHeight + settings.padding);

    if (cursorY + rowHeight > bottom) {
      doc.addPage();
      pages += 1;
      cursorY = top;
      if (settings.onNewPage) settings.onNewPage(doc);
      drawHeader();
    }

    if (settings.zebra && index % 2 === 1) {
      doc.rect(x, cursorY, width, rowHeight).fill(settings.zebra).stroke(settings.rowStroke);
    } else {
      doc.rect(x, cursorY, width, rowHeight).stroke(settings.rowStroke);
    }

    doc.fillColor(settings.color).font(settings.font);
    for (const column of columns) {
      doc.fontSize(column.fontSize || settings.fontSize);
      const inner = column.width - pad * 2;
      const value = cellText(column, row);
      const text = column.wrap ? value : fitText(doc, value, inner);
      doc.text(text, x + column.offset + pad, cursorY + pad + 1, {
        width: inner,
        align: column.align,
        ...(column.wrap ? {} : { lineBreak: false })
      });
    }

    cursorY += rowHeight;
  });

  return { y: cursorY, pages, rows: rows.length };
}

module.exports = { drawTable };
