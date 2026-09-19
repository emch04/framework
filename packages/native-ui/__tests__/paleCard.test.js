const { PALE_CARD_DOSAGE, mixColors, paleCardColors, parseColor, withAlpha } = require('../src/logic');

describe('parseColor', () => {
  test('reads every notation a theme uses', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#3B6CF0')).toEqual({ r: 59, g: 108, b: 240, a: 1 });
    expect(parseColor('#3b6cf080')).toEqual({ r: 59, g: 108, b: 240, a: 128 / 255 });
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor(' rgba(1,2,3,0.5) ')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  test('anything else is unreadable, not black', () => {
    expect(parseColor('tomato')).toBeNull();
    expect(parseColor('#12')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });
});

describe('mixColors / withAlpha', () => {
  test('a mix is OPAQUE and exact to the digit', () => {
    expect(mixColors('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mixColors('#ffffff', 'rgba(0,0,0,0.1)', 0.1)).toBe('#e6e6e6');
    expect(mixColors('#000000', '#ffffff', 0)).toBe('#000000');
  });

  test('an unreadable background falls back to white, an unreadable tint to the background', () => {
    expect(mixColors('nope', '#000000', 0.5)).toBe('#808080');
    expect(mixColors('#102030', 'nope', 0.5)).toBe('#102030');
  });

  test('withAlpha rewrites any notation', () => {
    expect(withAlpha('#ffffff', 0)).toBe('rgba(255,255,255,0)');
    expect(withAlpha('rgba(1,2,3,0.9)', 0.25)).toBe('rgba(1,2,3,0.25)');
    expect(withAlpha('tomato', 0.5)).toBe('tomato');
  });
});

describe('paleCardColors — flat, pale, in its own colour', () => {
  const page = '#ffffff';
  const ink = '#0d1235';

  test('a tinted card: its colour inside, lighter at the top, denser at the bottom', () => {
    const { fill, top, bottom } = paleCardColors({ scheme: 'light', pageBackground: page, ink, tint: '#3b6cf0' });
    expect(fill).toBe(mixColors(page, '#3b6cf0', 0.14));
    expect(top).toBe(mixColors(page, '#3b6cf0', 0.1));
    expect(bottom).toBe(mixColors(page, '#3b6cf0', 0.2));
    // Lighter top = further from the tint: closer to white on every channel.
    expect(parseColor(top).r).toBeGreaterThan(parseColor(bottom).r);
  });

  test('no tint, or an unreadable one: the neutral card, ink diluted, no gradient', () => {
    for (const tint of [undefined, null, 'not-a-colour']) {
      const colours = paleCardColors({ scheme: 'light', pageBackground: page, ink, tint });
      expect(colours.fill).toBe(mixColors(page, ink, 0.08));
      expect(colours.top).toBe(colours.bottom);
    }
  });

  test('on black the doses go up: the same proportion would vanish', () => {
    for (const variant of ['tinted', 'neutral']) {
      expect(PALE_CARD_DOSAGE.dark[variant].fill).toBeGreaterThan(PALE_CARD_DOSAGE.light[variant].fill);
    }
    const dark = paleCardColors({ scheme: 'dark', pageBackground: '#000000', ink: '#ffffff' });
    expect(dark.fill).toBe(mixColors('#000000', '#ffffff', 0.15));
  });

  test('the neutral light card is visible: at least 8 % of ink', () => {
    expect(PALE_CARD_DOSAGE.light.neutral.fill).toBeGreaterThanOrEqual(0.08);
  });

  test('the dosage table cannot be edited at run time', () => {
    expect(Object.isFrozen(PALE_CARD_DOSAGE.light.tinted)).toBe(true);
  });
});
