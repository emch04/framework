/**
 * The table of an AI answer, defect by defect, as each showed on a capture:
 * a header not facing its values, "Subscription" cut in the middle, cells
 * floating in room shared row by row.
 *
 * The rule is measurable without a simulator: the screen's density comes in
 * through the rounding function.
 */
const { TABLE_COLUMN_DEFAULTS, inlinesToText, isNumeric, measureColumns, parseInline } = require('../src/logic');

/* The rounding of a given density, as PixelRatio does it. */
const atDensity = (density) => (value) => Math.round(value * density) / density;

const CAPTURE = {
  header: ['School', 'Status', 'Subscription'],
  rows: [
    ['North Hill Institute', 'active', 'school'],
    ['Grace Learning Complex', 'trial', 'school'],
    ['Riverside Primary School', 'active', 'school']
  ]
};

test('a column has ONE width: the header and all its rows share it', () => {
  const { widths } = measureColumns(CAPTURE.header, CAPTURE.rows);
  expect(widths).toHaveLength(3);
  for (const width of widths) expect(width).toBeGreaterThan(0);
});

test('the longest header is no longer cut: its column holds it whole', () => {
  const { widths } = measureColumns(CAPTURE.header, CAPTURE.rows, { headerCharWidth: 6.9, padding: 20 });
  expect(widths[2]).toBeGreaterThanOrEqual(12 * 6.9 + 20);
});

test('NO WORD IS CUT IN THE MIDDLE, even longer than the ceiling', () => {
  const huge = 'Antidisestablishmentarianismmm';
  const { widths } = measureColumns(['Note'], [[huge]], { maxWidth: 120, charWidth: 6.4, padding: 20 });
  expect(widths[0]).toBeGreaterThanOrEqual(huge.length * 6.4 + 20);
});

test('a sentence in a cell does not blow up the column', () => {
  const sentence = 'many short words that all fit in one cell and would make it grow without end';
  const { widths } = measureColumns(['Comment'], [[sentence]], { maxWidth: 176 });
  expect(widths[0]).toBeLessThanOrEqual(176);
});

test('a short column is raised to the minimum', () => {
  expect(measureColumns(['A'], [['1']]).widths[0]).toBe(TABLE_COLUMN_DEFAULTS.minWidth);
});

test('every width lands on the screen\'s pixel grid', () => {
  for (const density of [1.5, 2, 3]) {
    const { widths } = measureColumns(CAPTURE.header, CAPTURE.rows, { round: atDensity(density), targetWidth: 333 });
    for (const width of widths) {
      expect(Math.abs(width * density - Math.round(width * density))).toBeLessThan(1e-9);
    }
  }
});

test('a narrow table fills its frame: the target width goes INTO the columns', () => {
  const { widths, totalWidth } = measureColumns(['A', 'B'], [['1', '2']], { targetWidth: 300 });
  expect(totalWidth).toBeGreaterThanOrEqual(300);
  // Proportionally: two columns of identical content stay equal.
  expect(widths[0]).toBe(widths[1]);
});

test('the rounding remainder goes to the widest column, and the target is met exactly', () => {
  const { widths, totalWidth } = measureColumns(['Name', 'N'], [['A long enough name', '1']], {
    targetWidth: 301,
    round: Math.floor
  });
  expect(totalWidth).toBe(301);
  expect(widths[0]).toBeGreaterThan(widths[1]);
});

test('a wide table is not shrunk by the target width', () => {
  const natural = measureColumns(CAPTURE.header, CAPTURE.rows).totalWidth;
  expect(natural).toBeGreaterThan(300);
  expect(measureColumns(CAPTURE.header, CAPTURE.rows, { targetWidth: 300 }).totalWidth).toBe(natural);
});

test('a row longer than the header does not lose its cell', () => {
  expect(measureColumns(['A', 'B'], [['1', '2', '3']]).widths).toHaveLength(3);
});

test('an empty table breaks nothing', () => {
  expect(measureColumns([], [])).toEqual({ widths: [], numeric: [], totalWidth: 0 });
});

test('a fully numeric column is recognised, a mixed one is not', () => {
  const { numeric } = measureColumns(
    ['Student', 'Average', 'Paid', 'Status', 'Empty'],
    [
      ['Ada Lovelace', '14,5', '$120', 'up to date', ''],
      ['Alan Turing', '11', '€80', 'late', '']
    ]
  );
  expect(numeric).toEqual([false, true, true, false, false]);
});

test('what counts as a number, and what does not', () => {
  for (const value of ['14', '14,5', '14.5', '$120', '120 $', '80 €', '£3', '87%', '12/20', '-3', '1 250']) {
    expect([value, isNumeric(value)]).toEqual([value, true]);
  }
  for (const value of ['', '  ', 'active', '6A', '2026-09-12', 'trial', 'n/a', undefined]) {
    expect([value, isNumeric(value)]).toEqual([value, false]);
  }
});

test('"NUMBE / R": a one-word header is never cut in two', () => {
  const { widths } = measureColumns(['School', 'Number', 'Total due'], [['Kinshasa Belgian School 1', '2', '450 $']], {
    targetWidth: 300
  });
  expect(widths[1]).toBeGreaterThanOrEqual('Number'.length * 6.9 + 24);
});

test('a date fits on one line, never cut in two', () => {
  const { widths } = measureColumns(
    ['Name', 'Status', 'Created'],
    [
      ['Miradi', 'active', '17/09/2026'],
      ['Demonstration School', 'active', '09/09/2026']
    ]
  );
  expect(widths[2]).toBeGreaterThanOrEqual('17/09/2026'.length * 7.4 + 24);
});

test('an uppercase spaced header holds whole: "STATUS" no longer breaks', () => {
  const { widths } = measureColumns(['Status'], [['Active'], ['Active']]);
  expect(widths[0]).toBeGreaterThanOrEqual(6 * 8 + 24);
});

test('columns grow with the phone\'s text size, never shrink below normal', () => {
  const normal = measureColumns(['City'], [['Kinshasa-Gombe']]).widths[0];
  expect(measureColumns(['City'], [['Kinshasa-Gombe']], { fontScale: 1.3 }).widths[0]).toBeGreaterThan(normal);
  expect(measureColumns(['City'], [['Kinshasa-Gombe']], { fontScale: 0.85 }).widths[0]).toBe(normal);
});

test('a cell is measured on its VISIBLE text: the stars of **bold** are not counted', () => {
  const visible = (cell) => inlinesToText(parseInline(cell));
  const raw = measureColumns(['Plan'], [['**Enterprise-Plus-Annual**']]).widths[0];
  const shown = measureColumns(['Plan'], [[visible('**Enterprise-Plus-Annual**')]]).widths[0];
  expect(shown).toBe(measureColumns(['Plan'], [['Enterprise-Plus-Annual']]).widths[0]);
  expect(shown).toBeLessThan(raw);
});

test('an emoji counts as one character, not as its two UTF-16 halves', () => {
  expect(measureColumns(['Mood'], [['\u{1F44D}'.repeat(20)]]).widths[0]).toBe(
    measureColumns(['Mood'], [['a'.repeat(20)]]).widths[0]
  );
});
