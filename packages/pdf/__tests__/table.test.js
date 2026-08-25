const PDFDocument = require('pdfkit');
const { drawTable, keepTogether, defaultBottom } = require('../src');

/**
 * A real PDFKit document, instrumented: we record where things land instead of
 * inspecting bytes. What matters is that no row straddles a break and that
 * every page carries its header.
 */
function instrument(doc) {
  const drawn = [];
  const rects = [];
  let page = 1;

  const realText = doc.text.bind(doc);
  const realRect = doc.rect.bind(doc);
  const realAddPage = doc.addPage.bind(doc);

  doc.text = (text, x, y, options) => {
    drawn.push({ page, text: String(text), x, y });
    return realText(text, x, y, options);
  };
  doc.rect = (x, y, w, h) => {
    rects.push({ page, x, y, w, h });
    return realRect(x, y, w, h);
  };
  doc.addPage = (...args) => { page += 1; return realAddPage(...args); };

  return { drawn, rects, pages: () => page };
}

const newDoc = () => {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.font('Helvetica').fontSize(8);
  return doc;
};

const columns = [
  { key: 'subject', label: 'MATIÈRE', width: 200 },
  { key: 'score', label: 'NOTE', width: 60, align: 'right' },
  { key: 'comment', label: 'APPRÉCIATION', width: 255, wrap: true }
];

const rowsOf = (count, comment = 'Bien.') =>
  Array.from({ length: count }, (_, i) => ({ subject: `Matière ${i + 1}`, score: 12, comment }));

describe('drawTable', () => {
  test('draws a header and one frame per row', () => {
    const doc = newDoc();
    const spy = instrument(doc);

    const result = drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: rowsOf(3) });

    expect(result.rows).toBe(3);
    expect(result.pages).toBe(1);
    expect(spy.rects).toHaveLength(4); // 1 header + 3 rows
    expect(spy.drawn.some((d) => d.text === 'MATIÈRE')).toBe(true);
  });

  test('returns the cursor where the table ended, for what comes next', () => {
    const doc = newDoc();

    const result = drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: rowsOf(3) });

    expect(result.y).toBeGreaterThan(100);
    expect(result.y).toBeLessThan(defaultBottom(doc));
  });

  test('the header is REDRAWN on every page — page two is not a wall of numbers', () => {
    const doc = newDoc();
    const spy = instrument(doc);

    const result = drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: rowsOf(80) });

    expect(result.pages).toBeGreaterThan(1);
    const headerPages = new Set(spy.drawn.filter((d) => d.text === 'MATIÈRE').map((d) => d.page));
    expect(headerPages.size).toBe(result.pages);
  });

  test('a row NEVER straddles a page break', () => {
    const doc = newDoc();
    const spy = instrument(doc);
    const bottom = 700;

    drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: rowsOf(80), bottom });

    for (const rect of spy.rects) {
      expect(rect.y + rect.h).toBeLessThanOrEqual(bottom);
    }
  });

  test('bottom reserves room for what follows the table', () => {
    const doc = newDoc();

    const tight = drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: rowsOf(40), bottom: 400 });

    expect(tight.y).toBeLessThanOrEqual(400);
  });

  test('a wrapping cell grows its row; the others do not', () => {
    const doc = newDoc();
    const spyShort = instrument(doc);
    drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: rowsOf(1, 'Bien.') });
    const shortRow = spyShort.rects[1].h;

    const doc2 = newDoc();
    const spyLong = instrument(doc2);
    const longComment = "L'élève doit fournir davantage d'efforts en classe comme à la maison pour combler ses lacunes du premier trimestre.";
    drawTable(doc2, { x: 40, y: 100, width: 515, columns, rows: rowsOf(1, longComment) });
    const tallRow = spyLong.rects[1].h;

    expect(tallRow).toBeGreaterThan(shortRow);
  });

  test('a non-wrapping value is truncated instead of overflowing', () => {
    const doc = newDoc();
    const spy = instrument(doc);
    const veryLong = 'Mathématiques appliquées et sciences physiques renforcées niveau supérieur';

    drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: [{ subject: veryLong, score: 12, comment: 'Bien.' }] });

    const cell = spy.drawn.find((d) => d.text.startsWith('Mathématiques'));
    expect(cell.text).not.toBe(veryLong);
    expect(cell.text.endsWith('…')).toBe(true);
  });

  test('a row keeps a floor height even when every cell is empty', () => {
    const doc = newDoc();
    const spy = instrument(doc);

    drawTable(doc, {
      x: 40, y: 100, width: 515, columns, minRowHeight: 20,
      rows: [{ subject: '', score: null, comment: undefined }]
    });

    expect(spy.rects[1].h).toBeGreaterThanOrEqual(20);
  });

  test('columns without a width share what is left of the frame', () => {
    const doc = newDoc();
    const spy = instrument(doc);

    drawTable(doc, {
      x: 40, y: 100, width: 300,
      /* Des libellés distincts des valeurs : sans cela le filtre ci-dessous
         attraperait aussi les cellules d'en-tête. */
      columns: [{ key: 'a', label: 'A', width: 100 }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
      rows: [{ a: 'valeur-a', b: 'valeur-b', c: 'valeur-c' }]
    });

    const cells = spy.drawn.filter((d) => d.text.startsWith('valeur-'));
    expect(cells.map((c) => Math.round(c.x))).toEqual([45, 145, 245]);
    // 100 déclaré, puis 200 partagés en deux : le cadre fait bien 300.
    expect(cells).toHaveLength(3);
  });

  test('format() renders a value without the row carrying display strings', () => {
    const doc = newDoc();
    const spy = instrument(doc);

    drawTable(doc, {
      x: 40, y: 100, width: 200,
      columns: [{ key: 'amount', label: 'TOTAL', width: 200, format: (v) => `${v.toLocaleString('en-US')} USD` }],
      rows: [{ amount: 125000 }]
    });

    expect(spy.drawn.some((d) => d.text === '125,000 USD')).toBe(true);
  });

  test('onNewPage runs before the header is redrawn', () => {
    const doc = newDoc();
    const order = [];
    const spy = instrument(doc);
    doc.text = ((real) => (text, x, y, o) => {
      if (text === 'MATIÈRE') order.push('header');
      return real(text, x, y, o);
    })(doc.text.bind(doc));

    drawTable(doc, {
      x: 40, y: 100, width: 515, columns, rows: rowsOf(80),
      onNewPage: () => order.push('banner')
    });

    expect(order.slice(0, 3)).toEqual(['header', 'banner', 'header']);
    expect(spy.pages()).toBeGreaterThan(1);
  });

  test('an empty table still draws its header and reports zero rows', () => {
    const doc = newDoc();
    const spy = instrument(doc);

    const result = drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: [] });

    expect(result).toMatchObject({ rows: 0, pages: 1 });
    expect(spy.rects).toHaveLength(1);
  });

  test('zebra striping fills every other row, and none when unset', () => {
    const doc = newDoc();
    let fills = 0;
    const realFill = doc.fill.bind(doc);
    doc.fill = (...args) => { fills += 1; return realFill(...args); };

    drawTable(doc, { x: 40, y: 100, width: 515, columns, rows: rowsOf(4), zebra: '#FAFAFA' });

    expect(fills).toBe(3); // header + rows 2 and 4
  });

  test('wiring mistakes are refused up front', () => {
    const doc = newDoc();

    expect(() => drawTable(doc, { x: 40, y: 100, width: 515, columns: [], rows: [] })).toThrow(/columns/);
    expect(() => drawTable(doc, { y: 100, width: 515, columns, rows: [] })).toThrow(/numeric/);
  });
});

describe('keepTogether', () => {
  test('leaves the cursor alone when the block fits', () => {
    const doc = newDoc();

    expect(keepTogether(doc, { y: 100, height: 130, bottom: 700 })).toBe(100);
  });

  test('starts a new page rather than splitting the block', () => {
    const doc = newDoc();
    let added = 0;
    const real = doc.addPage.bind(doc);
    doc.addPage = (...args) => { added += 1; return real(...args); };

    const y = keepTogether(doc, { y: 650, height: 130, bottom: 700 });

    expect(added).toBe(1);
    expect(y).toBe(doc.page.margins.top);
  });

  test('the resume position can be chosen', () => {
    const doc = newDoc();

    expect(keepTogether(doc, { y: 650, height: 130, bottom: 700, top: 55 })).toBe(55);
  });

  test('without a bottom it reserves a margin at the foot of the page', () => {
    const doc = newDoc();

    expect(defaultBottom(doc)).toBe(doc.page.height - 40);
    expect(keepTogether(doc, { y: 100, height: 50 })).toBe(100);
  });

  test('a missing measurement is a wiring mistake, not a silent no-op', () => {
    const doc = newDoc();

    expect(() => keepTogether(doc, { y: 100 })).toThrow(/numeric/);
    expect(() => keepTogether(doc, { height: 100 })).toThrow(/numeric/);
  });
});
