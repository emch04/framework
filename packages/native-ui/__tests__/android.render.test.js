/**
 * The same kit on Android: no Apple glass, so every surface must be VISIBLE
 * on its own — and must not draw what iOS would not (ghost shadows, grey blur).
 */
require('../test/dom');

jest.mock('react-native', () => require('../test/rn').reactNative(), { virtual: true });
jest.mock('react-native-reanimated', () => require('../test/rn').reanimated(), { virtual: true });
jest.mock('expo-glass-effect', () => require('../test/rn').glassEffect(), { virtual: true });
jest.mock('expo-blur', () => require('../test/rn').blur(), { virtual: true });
jest.mock('expo-linear-gradient', () => require('../test/rn').linearGradient(), { virtual: true });

// The probes answer yes: the rule must still say "not Apple's glass" off iOS.
globalThis.__platform = 'android';
globalThis.__liquidGlass = true;

const React = require('react');
const { render, cleanup } = require('@testing-library/react');
const ui = require('../src');

const h = React.createElement;
const style = (el) => JSON.parse(el.getAttribute('data-style'));
const props = (el) => JSON.parse(el.getAttribute('data-props'));
const byRn = (container, name) => [...container.querySelectorAll(`[data-rn="${name}"]`)];

afterEach(cleanup);

test('Android is never given Apple\'s glass, whatever the probes say', () => {
  expect(ui.getGlassMode()).not.toBe('native');
});

test('Apple\'s API is never even probed off iOS (some versions throw there)', () => {
  expect(globalThis.__probes || 0).toBe(0);
});

describe('GlassSurface off Apple\'s glass', () => {
  const shadow = { shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, boxShadow: '0 2px 8px black', elevation: 3 };

  test('a plain View, no GlassView and NO BLUR (Android\'s blur came out a dense grey)', () => {
    const { container } = render(h(ui.GlassSurface, null, 'x'));
    expect(byRn(container, 'GlassView')).toHaveLength(0);
    expect(byRn(container, 'BlurView')).toHaveLength(0);
    expect(container.firstChild.getAttribute('data-rn')).toBe('View');
  });

  test('THE TINT AT APPLE\'S WEIGHT: a quarter for a container', () => {
    const { container } = render(h(ui.GlassSurface, { tintColor: 'rgba(255,255,255,0.4)' }, 'x'));
    expect(style(container.firstChild).backgroundColor).toBe('rgba(255,255,255,0.100)');
  });

  test('a container loses its shadow (no ghost frame iOS would never draw)', () => {
    const { container } = render(h(ui.GlassSurface, { style: [{ borderRadius: 10 }, shadow] }, 'x'));
    const flat = style(container.firstChild);
    expect(flat.borderRadius).toBe(10);
    for (const key of ui.SHADOW_KEYS) expect(flat[key]).toBeUndefined();
  });

  test('an interactive surface keeps its shadow and gets the frost', () => {
    const { container } = render(h(ui.GlassSurface, { interactive: true, style: shadow, tintColor: 'rgba(255,255,255,0.14)' }, 'x'));
    expect(style(container.firstChild)).toMatchObject({ ...shadow, backgroundColor: 'rgba(255,255,255,0.484)' });
  });

  test('a group turns the spacing into a gap', () => {
    const { container } = render(h(ui.GlassGroup, { spacing: 10 }, 'a'));
    expect(byRn(container, 'GlassContainer')).toHaveLength(0);
    expect(style(container.firstChild).gap).toBe(10);
  });
});

describe('GlassButton on Android', () => {
  test('a real fill, no shadow halo, no glow, the ripple for feedback', () => {
    const { container, getByRole } = render(h(ui.GlassButton, { onPress: () => {}, accessibilityLabel: 'Back' }, 'x'));
    const surface = container.firstChild;
    // 0.9 white, frosted as interactive glass: 1 - 0.6 × 0.1.
    expect(style(surface).backgroundColor).toBe('rgba(255,255,255,0.940)');
    expect(style(surface).shadowOpacity).toBeUndefined();
    const button = getByRole('button');
    expect(style(button).shadowColor).toBeUndefined();
    expect(props(button).android_ripple).toMatchObject({ borderless: true });
  });

  test('a tinted button keeps its colour as paint', () => {
    const { container } = render(h(ui.GlassButton, { onPress: () => {}, tint: '#3b6cf0' }, 'x'));
    expect(style(container.firstChild).backgroundColor).toBe('#3b6cf0');
  });
});

describe('cards and bars on Android', () => {
  test('a tappable card is the pale card, not an imitation of glass', () => {
    const { container } = render(h(ui.TappableCard, { tint: '#3b6cf0' }, 'x'));
    expect(byRn(container, 'GlassView')).toHaveLength(0);
    expect(style(container.firstChild).borderRadius).toBe(ui.PALE_CARD_RADIUS);
    expect(byRn(container, 'LinearGradient')).toHaveLength(1);
  });

  test('the tab bar is a light card with a shadow, no glass', () => {
    const { getByTestId, container } = render(
      h(ui.TabBar, { tabs: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], activeKey: 'a', onSelect() {}, testID: 'bar' })
    );
    expect(byRn(container, 'GlassView')).toHaveLength(0);
    expect(style(getByTestId('bar').firstChild)).toMatchObject({ backgroundColor: '#fdfdff', elevation: 10 });
  });

  test('the dark tab bar is a dark card', () => {
    const { getByTestId } = render(
      h(ui.TabBar, { tabs: [{ key: 'a', label: 'A' }], activeKey: 'a', onSelect() {}, testID: 'bar', scheme: 'dark' })
    );
    expect(style(getByTestId('bar').firstChild).backgroundColor).toBe('#1c1c1e');
  });

  test('the pagination pill is a card', () => {
    const { container } = render(
      h(ui.FloatingPagination, {
        page: 1,
        totalPages: 2,
        canPrevious: false,
        canNext: true,
        onPrevious() {},
        onNext() {},
        previousLabel: 'Previous',
        nextLabel: 'Next'
      })
    );
    expect(byRn(container, 'GlassView')).toHaveLength(0);
    expect(style(container.firstChild.firstChild).backgroundColor).toBe('#fdfdff');
  });

  test('the header has no blur: a lighter, shorter page-colour fade', () => {
    const { container } = render(
      h(ui.CollapsibleHeader, {
        title: 'T',
        scrollY: { value: 999 },
        threshold: { value: 100 },
        pageBackground: '#f5f6fa'
      })
    );
    expect(byRn(container, 'BlurView')).toHaveLength(0);
    const background = byRn(container, 'Animated.View')[0];
    expect(style(background).height).toBe(ui.HEADER_BAR_HEIGHT + ui.HEADER_BOTTOM_FADE.android);
    expect(props(byRn(container, 'LinearGradient')[0]).colors).toEqual(ui.androidHeaderColors('#f5f6fa'));
  });

  test('a MaskedView given for iOS changes nothing on Android: still no blur', () => {
    const MaskedView = ({ children }) => h('div', { 'data-rn': 'MaskedView' }, children);
    const { container } = render(
      h(ui.CollapsibleHeader, { title: 'T', scrollY: { value: 0 }, threshold: { value: 100 }, MaskedView })
    );
    expect(byRn(container, 'MaskedView')).toHaveLength(0);
    expect(byRn(container, 'BlurView')).toHaveLength(0);
  });
});
