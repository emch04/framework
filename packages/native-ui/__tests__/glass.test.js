const {
  INTERACTIVE_FROST,
  TINT_WEIGHT,
  glassButtonMaterial,
  glassButtonTint,
  parseColor,
  surfaceStyleOffApple,
  tintAtAppleWeight
} = require('../src/logic');

const light = { mode: 'native', scheme: 'light', tinted: false };

describe('glassButtonMaterial — an object caught in an ice cube', () => {
  test('on a white page Apple\'s glass is CLEAR, not frosted', () => {
    // `regular` made the buttons grey and dull on a real iPhone.
    expect(glassButtonMaterial(light).glassStyle).toBe('clear');
    expect(glassButtonMaterial({ ...light, tinted: true }).glassStyle).toBe('clear');
    // In dark mode the frosting is what separates the button from the night.
    expect(glassButtonMaterial({ ...light, scheme: 'dark' }).glassStyle).toBe('regular');
    expect(glassButtonMaterial({ ...light, scheme: 'dark', tinted: true }).glassStyle).toBe('clear');
  });

  test('the highlight lights the top and thickens the foot: a volume, not a flat disc', () => {
    for (const scheme of ['light', 'dark']) {
      for (const tinted of [false, true]) {
        const [top, middle, foot] = glassButtonMaterial({ ...light, scheme, tinted }).highlight.map(parseColor);
        expect([top.r, top.g, top.b]).toEqual([255, 255, 255]);
        expect(top.a).toBeGreaterThan(0.1);
        expect(middle.a).toBe(0);
        expect(foot.r).toBeLessThan(50);
        expect(foot.a).toBeGreaterThan(0);
      }
    }
  });

  test('NO STROKE rings the glass: the light is inside', () => {
    for (const scheme of ['light', 'dark']) {
      for (const tinted of [false, true]) {
        expect(Object.keys(glassButtonMaterial({ ...light, scheme, tinted })).sort()).toEqual([
          'glassStyle',
          'glow',
          'highlight'
        ]);
      }
    }
  });

  test('the content glow exists only under Apple\'s glass', () => {
    // Android draws a fill-less view's shadow over the whole rectangle: a grey halo.
    expect(glassButtonMaterial({ ...light, mode: 'blur' }).glow).toBeNull();
    expect(glassButtonMaterial({ ...light, mode: 'fallback' }).glow).toBeNull();
    // Dark icon on light glass: a light halo lifts it.
    expect(glassButtonMaterial(light).glow.shadowColor).toBe('#ffffff');
    // Light icon (tinted button, dark mode): a dark shadow makes it pop.
    expect(glassButtonMaterial({ ...light, tinted: true }).glow.shadowColor).toBe('#000000');
    expect(glassButtonMaterial({ ...light, scheme: 'dark' }).glow.shadowColor).toBe('#000000');
    expect(glassButtonMaterial({ ...light, scheme: 'dark' }).glow.shadowOpacity).toBe(0.45);
  });
});

describe('tintAtAppleWeight — the weight Apple really gives a tint', () => {
  test('a container tint is quartered: Apple modulates its frost, it does not paint', () => {
    expect(TINT_WEIGHT).toBe(0.25);
    expect(tintAtAppleWeight('rgba(255,255,255,0.4)', false)).toBe('rgba(255,255,255,0.100)');
    expect(tintAtAppleWeight('rgba(255,255,255,0.12)', false)).toBe('rgba(255,255,255,0.030)');
  });

  test('an interactive tint gets the frost of Apple\'s interactive glass on top', () => {
    // 1 - (1 - 0.4)(1 - a): a button is LIGHTER than its background on iOS.
    expect(INTERACTIVE_FROST).toBe(0.4);
    expect(tintAtAppleWeight('rgba(255,255,255,0.14)', true)).toBe('rgba(255,255,255,0.484)');
    expect(tintAtAppleWeight('rgba(255,255,255,0)', true)).toBe('rgba(255,255,255,0.400)');
  });

  test('hex with alpha is weighed like rgba', () => {
    expect(tintAtAppleWeight('#ffffff66', false)).toBe('rgba(255,255,255,0.100)');
  });

  test('an OPAQUE colour is paint, not a tint: it is left alone', () => {
    expect(tintAtAppleWeight('#3b6cf0', false)).toBe('#3b6cf0');
    expect(tintAtAppleWeight('rgba(59,108,240,1)', false)).toBe('rgba(59,108,240,1)');
    expect(tintAtAppleWeight('tomato', true)).toBe('tomato');
  });
});

describe('surfaceStyleOffApple — iOS\'s shadow rule, applied on Android', () => {
  const style = {
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    boxShadow: '0 2px 8px black',
    elevation: 4
  };

  test('a container loses every shadow: iOS casts none from an almost transparent view', () => {
    expect(surfaceStyleOffApple(style, false)).toEqual({ borderRadius: 12 });
  });

  test('a button keeps its shadow: its frost is a real fill', () => {
    expect(surfaceStyleOffApple(style, true)).toEqual(style);
  });

  test('the caller\'s style object is never mutated', () => {
    const copy = { ...style };
    surfaceStyleOffApple(style, false);
    expect(style).toEqual(copy);
    expect(surfaceStyleOffApple(undefined, false)).toEqual({});
  });
});

describe('glassButtonTint', () => {
  test('a thin white under Apple\'s glass, a real fill anywhere else', () => {
    expect(glassButtonTint({ mode: 'native' })).toBe('rgba(255,255,255,0.14)');
    expect(glassButtonTint({ mode: 'native', selected: true })).toBe('rgba(255,255,255,0.35)');
    expect(glassButtonTint({ mode: 'blur' })).toBe('rgba(255,255,255,0.9)');
    expect(glassButtonTint({ mode: 'fallback', selected: true })).toBe('rgba(255,255,255,0.98)');
  });
});
