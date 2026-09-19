const { ANCHOR_MARGIN, anchorOffset, reserveBelowQuestion } = require('../src/logic');

describe('the question at the top, the answer below', () => {
  test('the question rises to the top, with a little air above it', () => {
    expect(anchorOffset(800)).toBe(800 - ANCHOR_MARGIN);
    expect(anchorOffset(4)).toBe(0);
  });

  test('a short answer leaves a reserve that lets the question rise', () => {
    // Screen of 700, thread of 900, question at 800: without a reserve the
    // scroll would stop at 200.
    const reserve = reserveBelowQuestion({ viewportHeight: 700, contentHeight: 900, anchorY: 800 });
    expect(reserve).toBe(700 - (900 - anchorOffset(800)));
    expect(900 + reserve - 700).toBeGreaterThanOrEqual(anchorOffset(800));
  });

  test('WITH ITS RESERVE THE THREAD STOPS EXACTLY ON THE QUESTION, even when the answer shrinks', () => {
    for (const contentHeight of [900, 1150, 1020, 1300]) {
      const reserve = reserveBelowQuestion({ viewportHeight: 700, contentHeight, anchorY: 800 });
      expect(contentHeight + reserve - 700).toBe(anchorOffset(800));
    }
  });

  test('the reserve shrinks as the answer grows, then disappears', () => {
    const before = reserveBelowQuestion({ viewportHeight: 700, contentHeight: 900, anchorY: 800 });
    const during = reserveBelowQuestion({ viewportHeight: 700, contentHeight: 1200, anchorY: 800 });
    expect(during).toBeLessThan(before);
    expect(reserveBelowQuestion({ viewportHeight: 700, contentHeight: 2000, anchorY: 800 })).toBe(0);
  });

  test('the reserve is a whole number of points', () => {
    expect(Number.isInteger(reserveBelowQuestion({ viewportHeight: 700.4, contentHeight: 900.1, anchorY: 800.3 }))).toBe(true);
  });
});
