const {
  COLLAPSE_THRESHOLD,
  INITIAL_COLLAPSE,
  MAX_BAR_SCALE,
  barScale,
  floatingBottomOffset,
  followScroll
} = require('../src/logic');

const walk = (offsets, state = INITIAL_COLLAPSE) => offsets.reduce(followScroll, state);

describe('followScroll — the Instagram fold', () => {
  test('scrolling down folds the bar, scrolling up brings it back', () => {
    const down = walk([100, 200, 300]);
    expect(down.collapsed).toBe(true);
    expect(walk([280], down).collapsed).toBe(false);
  });

  test('a finger tremor changes nothing', () => {
    const down = walk([100, 300]);
    expect(followScroll(down, 300 - COLLAPSE_THRESHOLD).collapsed).toBe(true);
    expect(followScroll({ collapsed: false, anchor: 200 }, 200 + COLLAPSE_THRESHOLD).collapsed).toBe(false);
  });

  test('the threshold is strict on both sides: one point past it counts', () => {
    expect(followScroll({ collapsed: false, anchor: 200 }, 200 + COLLAPSE_THRESHOLD + 1).collapsed).toBe(true);
    expect(followScroll({ collapsed: true, anchor: 300 }, 300 - COLLAPSE_THRESHOLD - 1).collapsed).toBe(false);
  });

  test('A SLOW SCROLL STILL COUNTS: compared to the anchor, not the previous frame', () => {
    const slow = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(walk(slow, { collapsed: false, anchor: 100 }).collapsed).toBe(true);
  });

  test('a tremor keeps the SAME state object: no re-render for nothing', () => {
    const state = { collapsed: true, anchor: 300 };
    expect(followScroll(state, 303)).toBe(state);
  });

  test('back in the top zone the bar is full, even after a travel below the threshold', () => {
    // Folded with its anchor just below the top zone: 6 points up would be a
    // tremor anywhere else, but at the top of the page the bar must be full.
    expect(followScroll({ collapsed: true, anchor: 30 }, 24)).toEqual({ collapsed: false, anchor: 24 });
  });

  test('at the very top the bar is full, even on the rubber-band bounce', () => {
    const down = walk([100, 400]);
    expect(followScroll(down, 10).collapsed).toBe(false);
    expect(followScroll(down, -40)).toEqual({ collapsed: false, anchor: 0 });
  });
});

describe('barScale — bigger on a big phone, never smaller', () => {
  test('the reference phone keeps its size, a small one too', () => {
    expect(barScale(390)).toBe(1);
    expect(barScale(360)).toBe(1);
  });

  test('a large iPhone gets about 10 % more, a tablet is capped', () => {
    expect(barScale(430)).toBeGreaterThan(1.09);
    expect(barScale(430)).toBeLessThan(1.11);
    expect(barScale(834)).toBe(MAX_BAR_SCALE);
  });

  test('an unmeasured window does not break the bar', () => {
    expect(barScale(undefined)).toBe(1);
  });
});

describe('floatingBottomOffset', () => {
  test('clears the home indicator, never glued to the bottom edge', () => {
    expect(floatingBottomOffset(34)).toBe(42);
    expect(floatingBottomOffset(0)).toBe(18);
    expect(floatingBottomOffset(undefined)).toBe(18);
  });
});
