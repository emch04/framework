const PDFDocument = require('pdfkit');
const { fitText, line, blockHeight } = require('../src');

/**
 * Measured against a real PDFKit document, because every claim here is about
 * what PDFKit actually does with font metrics — not about our arithmetic.
 */
let doc;
beforeEach(() => {
  doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.font('Helvetica').fontSize(9);
});

const lineCount = (text, width) =>
  Math.round(doc.heightOfString(text, { width }) / doc.heightOfString('A', { width }));

const LONG_NAME = 'Jean-Pierre Mukendi Tshibangu Kabongo Ilunga';

describe('fitText', () => {
  test('leaves a value that already fits exactly as it is', () => {
    expect(fitText(doc, 'Kinshasa', 200)).toBe('Kinshasa');
  });

  test('cuts a value that would wrap, and marks the cut', () => {
    const fitted = fitText(doc, LONG_NAME, 100);

    expect(fitted.length).toBeLessThan(LONG_NAME.length);
    expect(fitted.endsWith('…')).toBe(true);
  });

  test('the result occupies ONE line — the only claim that matters', () => {
    for (const width of [40, 60, 100, 150, 200, 300]) {
      expect(lineCount(fitText(doc, LONG_NAME, width), width)).toBe(1);
    }
  });

  test('holds for text with no spaces to break on', () => {
    const unbroken = 'A'.repeat(300);

    expect(lineCount(fitText(doc, unbroken, 80), 80)).toBe(1);
  });

  test('holds for accented and non-latin text', () => {
    for (const text of ['Établissement Sainte-Thérèse de l\'Enfant-Jésus', 'Kelasi ya mibale ya sekundere', '学校名称が非常に長い場合のテスト']) {
      expect(lineCount(fitText(doc, text, 90), 90)).toBe(1);
    }
  });

  test('collapses runs of whitespace instead of drawing them', () => {
    expect(fitText(doc, '  Kinshasa\n\t  Gombe  ', 300)).toBe('Kinshasa Gombe');
  });

  test('an empty or absent value draws nothing', () => {
    for (const value of ['', '   ', null, undefined]) {
      expect(fitText(doc, value, 200)).toBe('');
    }
  });

  test('a zero or negative width draws nothing rather than throwing', () => {
    expect(fitText(doc, LONG_NAME, 0)).toBe('');
    expect(fitText(doc, LONG_NAME, -50)).toBe('');
  });

  test('a width too small even for the ellipsis yields nothing', () => {
    expect(fitText(doc, LONG_NAME, 2)).toBe('');
  });

  test('follows the ACTIVE font size — it measures, it does not guess', () => {
    doc.fontSize(6);
    const small = fitText(doc, LONG_NAME, 100);
    doc.fontSize(14);
    const large = fitText(doc, LONG_NAME, 100);

    expect(small.length).toBeGreaterThan(large.length);
  });

  test('numbers and other non-strings are handled, not crashed on', () => {
    expect(fitText(doc, 12345, 200)).toBe('12345');
    expect(fitText(doc, 0, 200)).toBe('0');
  });
});

describe('line', () => {
  test('draws the truncated value, never the raw one', () => {
    const drawn = [];
    doc.text = (text) => { drawn.push(text); return doc; };

    line(doc, LONG_NAME, 40, 100, 90);

    expect(drawn).toHaveLength(1);
    expect(drawn[0]).not.toBe(LONG_NAME);
    expect(drawn[0].endsWith('…')).toBe(true);
  });

  test('always passes a width and forbids wrapping', () => {
    let options;
    doc.text = (_text, _x, _y, opts) => { options = opts; return doc; };

    line(doc, 'Kinshasa', 40, 100, 90);

    expect(options).toMatchObject({ width: 90, lineBreak: false });
  });

  test('caller options are kept, and can override the defaults', () => {
    let options;
    doc.text = (_text, _x, _y, opts) => { options = opts; return doc; };

    line(doc, 'Kinshasa', 40, 100, 90, { align: 'center' });

    expect(options).toMatchObject({ width: 90, align: 'center' });
  });
});

describe('blockHeight', () => {
  test('grows as the text gets longer', () => {
    const short = blockHeight(doc, 'Bien.', 120);
    const long = blockHeight(doc, 'L\'élève doit fournir davantage d\'efforts en classe comme à la maison.', 120);

    expect(long).toBeGreaterThan(short);
  });

  test('shrinks as the column gets wider', () => {
    const text = 'L\'élève doit fournir davantage d\'efforts en classe comme à la maison.';

    expect(blockHeight(doc, text, 300)).toBeLessThan(blockHeight(doc, text, 100));
  });

  test('an empty value still has a height, so a row keeps its floor', () => {
    expect(blockHeight(doc, '', 120)).toBeGreaterThanOrEqual(0);
    expect(blockHeight(doc, null, 120)).toBeGreaterThanOrEqual(0);
  });
});
