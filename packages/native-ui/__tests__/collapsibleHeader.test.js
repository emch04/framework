const {
  HEADER_BAR_HEIGHT,
  HEADER_BOTTOM_FADE,
  HEADER_FADE_RUN,
  androidHeaderColors,
  headerBarFade,
  headerBottomFade,
  headerGradientStops,
  headerThreshold,
  headerTitleFade
} = require('../src/logic');

describe('headerThreshold — when the large title has gone', () => {
  test('the bar is fully shown when the title\'s bottom passes under it', () => {
    expect(headerThreshold(200)).toBe(200 - HEADER_BAR_HEIGHT);
  });

  test('an inset padded inside the scroll comes off too', () => {
    expect(headerThreshold(247, 47)).toBe(200 - HEADER_BAR_HEIGHT);
  });

  test('never below 40: a tiny title does not show the bar at the first pixel', () => {
    expect(headerThreshold(60)).toBe(40);
  });
});

describe('the fades', () => {
  test('the bar fades in over the run just BEFORE the threshold', () => {
    expect(headerBarFade(150)).toEqual({ input: [150 - HEADER_FADE_RUN, 150], output: [0, 1] });
  });

  test('the small title starts later than the bar and rises into place', () => {
    const { opacity, translateY } = headerTitleFade(150);
    expect(opacity.input[0]).toBeGreaterThan(headerBarFade(150).input[0]);
    expect(opacity.input[1]).toBeGreaterThan(150);
    expect(translateY.output).toEqual([6, 0]);
  });

  test('Android\'s fade is shorter and lighter than iOS\'s', () => {
    expect(headerBottomFade('android')).toBe(HEADER_BOTTOM_FADE.android);
    expect(headerBottomFade('ios')).toBe(HEADER_BOTTOM_FADE.ios);
    expect(HEADER_BOTTOM_FADE.android).toBeLessThan(HEADER_BOTTOM_FADE.ios);
  });

  test('A FADE, NOT A LINE: solid to the bar\'s edge, then dying out in the overflow', () => {
    const barHeight = 47 + HEADER_BAR_HEIGHT;
    const stops = headerGradientStops(barHeight, 26);
    expect(stops[0]).toBe(0);
    expect(stops[1]).toBeCloseTo(barHeight / (barHeight + 26));
    expect(stops[2]).toBe(1);
  });

  test('Android\'s background lets the content show, then vanishes — from any colour notation', () => {
    expect(androidHeaderColors('#f5f6fa')).toEqual(['rgba(245,246,250,0.94)', 'rgba(245,246,250,0.8)', 'rgba(245,246,250,0)']);
    expect(androidHeaderColors('rgb(0, 0, 0)')[2]).toBe('rgba(0,0,0,0)');
    expect(androidHeaderColors(undefined)[0]).toBe('rgba(255,255,255,0.94)');
  });
});
