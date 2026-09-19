/**
 * The kit mounted as an iPhone on iOS 26 sees it: Apple's glass available.
 * The peers are mocked to DOM elements (test/rn.js); what is checked is the
 * structure the finger and the screen reader meet, and what a tap calls.
 */
require('../test/dom');

jest.mock('react-native', () => require('../test/rn').reactNative(), { virtual: true });
jest.mock('react-native-reanimated', () => require('../test/rn').reanimated(), { virtual: true });
jest.mock('expo-glass-effect', () => require('../test/rn').glassEffect(), { virtual: true });
jest.mock('expo-blur', () => require('../test/rn').blur(), { virtual: true });
jest.mock('expo-linear-gradient', () => require('../test/rn').linearGradient(), { virtual: true });

globalThis.__platform = 'ios';
globalThis.__liquidGlass = true;

const React = require('react');
const { render, act, fireEvent, cleanup } = require('@testing-library/react');
const ui = require('../src');

const h = React.createElement;
const props = (el) => JSON.parse(el.getAttribute('data-props'));
const style = (el) => JSON.parse(el.getAttribute('data-style'));
const byRn = (container, name) => [...container.querySelectorAll(`[data-rn="${name}"]`)];

afterEach(() => {
  cleanup();
  globalThis.__springs = [];
  globalThis.__reduceMotion = false;
  globalThis.__scheme = 'light';
});

test('the device reports Apple\'s glass, through @astratra/native\'s rule', () => {
  expect(ui.getGlassMode()).toBe('native');
});

describe('GlassSurface / GlassGroup', () => {
  test('Apple\'s GlassView, with the APP\'s scheme and the tint as given', () => {
    globalThis.__scheme = 'dark';
    const { container } = render(h(ui.GlassSurface, { tintColor: 'rgba(255,255,255,0.4)', interactive: true }, 'x'));
    const [glass] = byRn(container, 'GlassView');
    expect(props(glass)).toMatchObject({
      glassEffectStyle: 'regular',
      tintColor: 'rgba(255,255,255,0.4)',
      colorScheme: 'dark',
      isInteractive: true
    });
  });

  test('the scheme prop wins over the phone\'s', () => {
    globalThis.__scheme = 'dark';
    const { container } = render(h(ui.GlassSurface, { scheme: 'light' }, 'x'));
    expect(props(byRn(container, 'GlassView')[0]).colorScheme).toBe('light');
  });

  test('a group is a GlassContainer carrying the spacing', () => {
    const { container } = render(h(ui.GlassGroup, { spacing: 12 }, 'a'));
    expect(props(byRn(container, 'GlassContainer')[0]).spacing).toBe(12);
  });
});

describe('GlassButton', () => {
  test('LAYERS: tint, then highlight, then the content — nothing veils the icon', () => {
    const { container } = render(
      h(ui.GlassButton, { tint: '#3b6cf0', onPress: () => {}, accessibilityLabel: 'Send' }, h('i', { id: 'icon' }))
    );
    const glass = byRn(container, 'GlassView')[0];
    const layers = [...glass.children].map((el) => el.getAttribute('data-rn'));
    expect(layers).toEqual(['View', 'LinearGradient', 'Pressable']);
    const [tint, highlight, pressable] = glass.children;
    expect(style(tint)).toMatchObject({ backgroundColor: '#3b6cf0', opacity: 0.8 });
    // The layers above the content never take the finger.
    expect(props(tint).pointerEvents).toBe('none');
    expect(props(highlight).pointerEvents).toBe('none');
    // The icon is inside the pressable, which carries no fill of its own.
    expect(pressable.querySelector('#icon')).not.toBeNull();
    expect(style(pressable).backgroundColor).toBeUndefined();
  });

  test('the glow sits on the pressable (iOS casts it on the icon\'s silhouette)', () => {
    const { getByRole } = render(h(ui.GlassButton, { onPress: () => {}, accessibilityLabel: 'Back' }, 'x'));
    expect(style(getByRole('button'))).toMatchObject({ shadowColor: '#ffffff', shadowOpacity: 0.95 });
  });

  test('the glass style comes from the policy: clear on a light page', () => {
    const { container } = render(h(ui.GlassButton, { onPress: () => {} }, 'x'));
    expect(props(byRn(container, 'GlassView')[0]).glassEffectStyle).toBe('clear');
  });

  test('an untinted button has a highlight but no colour layer', () => {
    const { container } = render(h(ui.GlassButton, { onPress: () => {} }, 'x'));
    expect([...byRn(container, 'GlassView')[0].children].map((el) => el.getAttribute('data-rn'))).toEqual([
      'LinearGradient',
      'Pressable'
    ]);
  });

  test('a tap calls onPress; disabled, it does not, and is announced so', () => {
    const onPress = jest.fn();
    const { getByRole, rerender } = render(h(ui.GlassButton, { onPress, accessibilityLabel: 'Go' }, 'x'));
    fireEvent.click(getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(h(ui.GlassButton, { onPress, disabled: true, accessibilityLabel: 'Go' }, 'x'));
    fireEvent.click(getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(getByRole('button').getAttribute('aria-disabled')).toBe('true');
  });

  test('a pill has no fixed width, a circle does', () => {
    const { container, rerender } = render(h(ui.GlassButton, { size: 40 }, 'x'));
    expect(style(byRn(container, 'GlassView')[0])).toMatchObject({ width: 40, height: 40, borderRadius: 20 });
    rerender(h(ui.GlassButton, { size: 40, pill: true }, 'x'));
    expect(style(byRn(container, 'GlassView')[0]).width).toBeUndefined();
  });
});

describe('TappableCard / PaleCard', () => {
  test('on iOS a tappable card is interactive glass with a trace of the accent', () => {
    const { container } = render(h(ui.TappableCard, { tint: '#3b6cf0' }, 'x'));
    expect(props(byRn(container, 'GlassView')[0])).toMatchObject({
      isInteractive: true,
      tintColor: 'rgba(59,108,240,0.08)'
    });
  });

  test('a pale card is never glass, on iOS either: flat, opaque, its gradient inside', () => {
    const { container } = render(h(ui.PaleCard, { tint: '#3b6cf0' }, 'x'));
    expect(byRn(container, 'GlassView')).toHaveLength(0);
    const card = container.firstChild;
    const colours = ui.paleCardColors({ scheme: 'light', pageBackground: '#ffffff', ink: '#0d1235', tint: '#3b6cf0' });
    expect(style(card)).toMatchObject({ backgroundColor: colours.fill, borderRadius: ui.PALE_CARD_RADIUS });
    expect(style(card).borderWidth).toBeUndefined();
    expect(style(card).shadowOpacity).toBeUndefined();
    expect(props(byRn(container, 'LinearGradient')[0]).colors).toEqual([colours.top, colours.bottom]);
  });

  test('a neutral pale card has no gradient to draw', () => {
    const { container } = render(h(ui.PaleCard, null, 'x'));
    expect(byRn(container, 'LinearGradient')).toHaveLength(0);
  });
});

describe('TabBar', () => {
  const icon = ({ color, active }) => h('i', { 'data-color': color, 'data-active': String(active) });
  const tabs = [
    { key: 'home', label: 'Home', icon },
    { key: 'messages', label: 'Messages', badge: 3, icon },
    { key: 'assistant', label: 'Assistant', icon },
    { key: 'people', label: 'People', badge: 120, icon },
    { key: 'more', label: 'More', icon }
  ];
  const mount = (extra = {}) =>
    render(h(ui.TabBar, { tabs, activeKey: 'home', onSelect: jest.fn(), centerKey: 'assistant', testID: 'bar', ...extra }));

  test('the active tab is announced selected, badges are read, the centre tab sits in the middle', () => {
    const { getAllByRole } = mount();
    const found = getAllByRole('tab');
    expect(found.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Home',
      'Messages, 3',
      'People, 120',
      'More',
      'Assistant'
    ]);
    expect(found[0].getAttribute('aria-selected')).toBe('true');
    expect(found[1].getAttribute('aria-selected')).toBe('false');
  });

  test('the centre tab leaves an empty slot in the middle of the row and floats above it', () => {
    const { getByTestId } = mount();
    const [glass, row] = getByTestId('bar').firstChild.children;
    expect(glass.getAttribute('data-rn')).toBe('GlassView');
    // First child of the row is the pill, then the five cells.
    const cells = [...row.children].slice(1);
    expect(cells).toHaveLength(5);
    expect(cells[2].children).toHaveLength(0);
    expect(cells[2].querySelector('[role="tab"]')).toBeNull();
    // The raised button is outside the bar, not inside the slot.
    expect(row.contains(getByTestId('bar-assistant'))).toBe(false);
  });

  test('a badge past 99 reads 99+', () => {
    const { container } = mount();
    const badges = [...container.querySelectorAll('span[data-rn="Text"]')].map((el) => el.textContent);
    expect(badges).toEqual(expect.arrayContaining(['3', '99+']));
  });

  test('the Dock\'s glass on iOS, tinted to the app\'s scheme', () => {
    globalThis.__scheme = 'dark';
    const { container } = mount();
    expect(props(byRn(container, 'GlassView')[0])).toMatchObject({
      tintColor: 'rgba(0,0,0,0.62)',
      colorScheme: 'dark'
    });
  });

  test('THE PILL SLIDES to the tapped tab, and the page opens only after it', async () => {
    jest.useFakeTimers();
    try {
      const onSelect = jest.fn();
      const onHaptic = jest.fn();
      const { getByTestId } = mount({ onSelect, onHaptic });
      globalThis.__springs = [];
      fireEvent.click(getByTestId('bar-people'));
      // Row measured at 300: 5 cells of (300 - 8) / 5; "people" is cell 3.
      const cell = ui.tabCellWidth(300, 5);
      expect(globalThis.__springs).toContain(ui.pillOffset(['home', 'messages', 'assistant', 'people', 'more'], 'people', cell));
      expect(onHaptic).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
      expect(getByTestId('bar-people').getAttribute('aria-selected')).toBe('true');
      act(() => {
        jest.advanceTimersByTime(ui.TAB_OPEN_DELAY);
      });
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'people' }));
    } finally {
      jest.useRealTimers();
    }
  });

  test('THE CENTRE TAB NEVER TAKES THE PILL: it opens at once, the selection stays', () => {
    const onSelect = jest.fn();
    const { getByTestId } = mount({ onSelect });
    globalThis.__springs = [];
    fireEvent.click(getByTestId('bar-assistant'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'assistant' }));
    expect(globalThis.__springs).toEqual([]);
    expect(getByTestId('bar-home').getAttribute('aria-selected')).toBe('true');
  });

  test('tapping the active tab calls through at once, without haptic or slide', () => {
    const onSelect = jest.fn();
    const onHaptic = jest.fn();
    const { getByTestId } = mount({ onSelect, onHaptic });
    fireEvent.click(getByTestId('bar-home'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onHaptic).not.toHaveBeenCalled();
  });

  test('with Reduce motion, the pill jumps and the page opens at once', () => {
    globalThis.__reduceMotion = true;
    const onSelect = jest.fn();
    const { getByTestId } = mount({ onSelect });
    globalThis.__springs = [];
    fireEvent.click(getByTestId('bar-more'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(globalThis.__springs).toEqual([]);
  });

  test('a new activeKey brings the pill back to the screen\'s tab', () => {
    const { getByTestId, rerender } = mount();
    rerender(h(ui.TabBar, { tabs, activeKey: 'more', onSelect: jest.fn(), centerKey: 'assistant', testID: 'bar' }));
    expect(getByTestId('bar-more').getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('bar-home').getAttribute('aria-selected')).toBe('false');
  });

  test('icons receive the active and idle inks', () => {
    const { container } = mount();
    const inks = [...container.querySelectorAll('i')].map((el) => [el.getAttribute('data-active'), el.getAttribute('data-color')]);
    expect(inks).toContainEqual(['true', '#0d1235']);
    expect(inks).toContainEqual(['false', '#343a52']);
  });

  test('without a centre key the bar is a plain row of equal tabs', () => {
    const { getAllByRole } = mount({ centerKey: undefined });
    expect(getAllByRole('tab').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Home',
      'Messages, 3',
      'Assistant',
      'People, 120',
      'More'
    ]);
  });

  test('the bar grows on a large phone and sits above the home indicator', () => {
    globalThis.__windowWidth = 430;
    try {
      const { getByTestId } = mount({ bottomInset: 34 });
      expect(style(getByTestId('bar')).bottom).toBe(42);
      const bar = getByTestId('bar').firstChild;
      expect(style(bar).height).toBeCloseTo(ui.TAB_BAR_HEIGHT * ui.barScale(430));
    } finally {
      globalThis.__windowWidth = 390;
    }
  });

  test('a collapse value folds the bar and fades the labels', () => {
    const collapse = { value: 1 };
    const { getByTestId, getAllByText } = mount({ collapse });
    expect(style(getByTestId('bar')).transform).toEqual([{ translateY: 6 }, { scale: 0.84 }]);
    expect(style(getAllByText('Home')[0]).opacity).toBe(0);
  });
});

describe('FloatingPagination', () => {
  const base = {
    page: 2,
    totalPages: 7,
    canPrevious: true,
    canNext: false,
    previousLabel: 'Previous page',
    nextLabel: 'Next page'
  };

  test('two labelled arrows, the count in between, the dead end announced', () => {
    const onPrevious = jest.fn();
    const onNext = jest.fn();
    const onHaptic = jest.fn();
    const { getByLabelText, container } = render(h(ui.FloatingPagination, { ...base, onPrevious, onNext, onHaptic }));
    fireEvent.click(getByLabelText('Previous page'));
    fireEvent.click(getByLabelText('Next page'));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    expect(onHaptic).toHaveBeenCalledTimes(1);
    expect(getByLabelText('Next page').getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toBe('2  /  7');
  });

  test('glass on iOS; it sits above a footer button when told to', () => {
    const { container } = render(h(ui.FloatingPagination, { ...base, onPrevious() {}, onNext() {}, bottom: 90, testID: 'p' }));
    expect(byRn(container, 'GlassView')).toHaveLength(1);
    expect(style(container.querySelector('[data-testid="p"]')).bottom).toBe(90);
  });
});

describe('CollapsibleHeader / CollapsibleScreen', () => {
  const shared = (value) => ({ value });

  test('before the threshold: bar and small title invisible; leading and actions always there', () => {
    const { container, getByText, getByLabelText } = render(
      h(ui.CollapsibleHeader, {
        title: 'Schools',
        scrollY: shared(0),
        threshold: shared(150),
        topInset: 47,
        leading: h('button', { 'aria-label': 'Back' }),
        actions: h('button', { 'aria-label': 'Add' })
      })
    );
    expect(getByLabelText('Back')).toBeTruthy();
    expect(getByLabelText('Add')).toBeTruthy();
    const background = byRn(container, 'Animated.View')[0];
    expect(style(background).opacity).toBe(0);
    expect(style(getByText('Schools').parentElement).opacity).toBe(0);
    expect(getByText('Schools').getAttribute('role')).toBe('header');
  });

  test('past the threshold: the bar is there, blurred by the system material', () => {
    const { container, getByText } = render(
      h(ui.CollapsibleHeader, { title: 'Schools', scrollY: shared(400), threshold: shared(150), topInset: 47 })
    );
    const background = byRn(container, 'Animated.View')[0];
    expect(style(background)).toMatchObject({ opacity: 1, height: 47 + ui.HEADER_BAR_HEIGHT + ui.HEADER_BOTTOM_FADE.ios });
    expect(props(byRn(container, 'BlurView')[0]).tint).toBe('systemChromeMaterialLight');
    expect(style(getByText('Schools').parentElement).opacity).toBe(1);
  });

  test('with a MaskedView the blur itself fades out; without, the page colour carries the fade', () => {
    const MaskedView = ({ children, maskElement }) => h('div', { 'data-rn': 'MaskedView' }, maskElement, children);
    const args = { title: 'T', scrollY: shared(0), threshold: shared(100) };
    const masked = render(h(ui.CollapsibleHeader, { ...args, MaskedView }));
    expect(byRn(masked.container, 'MaskedView')).toHaveLength(1);
    expect(props(byRn(masked.container, 'LinearGradient')[0]).colors).toEqual(['#000000', '#000000', 'rgba(0,0,0,0)']);
    cleanup();
    const bare = render(h(ui.CollapsibleHeader, { ...args, pageBackground: '#f5f6fa' }));
    expect(props(byRn(bare.container, 'LinearGradient')[0]).colors).toEqual(ui.androidHeaderColors('#f5f6fa'));
    expect(byRn(bare.container, 'BlurView')).toHaveLength(1);
  });

  test('the screen pads its content under the header and measures the large title', () => {
    const onScroll = jest.fn();
    const screen = (extra) =>
      h(ui.CollapsibleScreen, { title: 'Settings', largeTitle: h('h1', null, 'Settings'), scrollProps: { onScroll }, ...extra }, 'body');
    const { container, getAllByText, rerender } = render(screen());
    const scroll = byRn(container, 'ScrollView')[0];
    expect(props(scroll).scrollEventThrottle).toBe(16);
    expect(getAllByText('Settings')).toHaveLength(2);
    // The title block measures 40 high at the top: threshold max(40, 40 - 52) = 40,
    // well before the 72 used until a title is measured. At 45 the bar is fully in.
    globalThis.__scrollY = 45;
    try {
      fireEvent.scroll(scroll);
      rerender(screen({ gutter: 16 }));
      expect(style(byRn(container, 'Animated.View')[0]).opacity).toBe(1);
      // The caller's own onScroll still receives the event.
      expect(onScroll).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.__scrollY = 0;
    }
  });
});

describe('MarkdownView', () => {
  test('an answer renders its blocks, without the stars', () => {
    const { container, getByRole } = render(h(ui.MarkdownView, { content: '## Summary\n\nThe **mark** is *low*.' }));
    expect(getByRole('header').textContent).toBe('Summary');
    expect(container.textContent).toBe('SummaryThe mark is low.');
  });

  test('numbered lists continue across the bullets between their steps', () => {
    const { container } = render(h(ui.MarkdownView, { content: '1. Role\n- Director\n1. School\n- Name\n1. Password' }));
    const markers = [...container.querySelectorAll('span')].map((el) => el.textContent).filter((t) => /^\d+\.$/.test(t));
    expect(markers).toEqual(['1.', '2.', '3.']);
  });

  test('a person\'s own message stays as typed', () => {
    const { container } = render(h(ui.MarkdownView, { content: '**not bold** - still text', plain: true }));
    expect(container.textContent).toBe('**not bold** - still text');
  });

  test('BOLD IN A TABLE CELL: shown bold, no stars, and the column fits the visible text', () => {
    const { container } = render(h(ui.MarkdownView, { content: '| Plan | Price |\n|---|---|\n| **Starter** | $19 |' }));
    expect(container.textContent).not.toContain('*');
    const boxes = byRn(container, 'View').filter((el) => style(el).paddingHorizontal === 12);
    // Header and row share each column's width.
    expect(style(boxes[0]).width).toBe(style(boxes[2]).width);
    expect(style(boxes[1]).width).toBe(style(boxes[3]).width);
    // The numeric column is right-aligned.
    expect(style(boxes[3].firstChild).textAlign).toBe('right');
    expect(style(boxes[2].firstChild).textAlign).toBeUndefined();
  });

  test('a link opens through onLinkPress (Linking by default)', () => {
    const onLinkPress = jest.fn();
    const { getByRole } = render(h(ui.MarkdownView, { content: 'see [docs](https://example.test)', onLinkPress }));
    fireEvent.click(getByRole('link'));
    expect(onLinkPress).toHaveBeenCalledWith('https://example.test');
  });

  test('a code block copies ALONE, and says it did', async () => {
    const onCopyCode = jest.fn(() => Promise.resolve());
    const { getByLabelText, container } = render(
      h(ui.MarkdownView, {
        content: 'Run:\n\n```sh\nnpm test\n```',
        onCopyCode,
        copyLabel: 'Copy',
        copyIcon: h('i', { id: 'copy' }),
        copiedIcon: h('i', { id: 'copied' })
      })
    );
    await act(async () => {
      fireEvent.click(getByLabelText('Copy'));
    });
    expect(onCopyCode).toHaveBeenCalledWith('npm test');
    expect(container.querySelector('#copied')).not.toBeNull();
  });

  test('no copy callback, no copy button — an icon alone is not enough', () => {
    const { queryByRole } = render(h(ui.MarkdownView, { content: '```\nx\n```', copyIcon: h('i') }));
    expect(queryByRole('button')).toBeNull();
  });

  test('style overrides merge with the defaults', () => {
    const { container } = render(h(ui.MarkdownView, { content: 'hi', styles: { body: { color: 'red' } } }));
    expect(style(container.querySelector('span'))).toMatchObject({ color: 'red', fontSize: 15 });
  });
});

describe('useCollapsingBar', () => {
  test('scroll offsets drive the spring: fold on the way down, unfold on the way up', () => {
    let api;
    function Probe() {
      api = ui.useCollapsingBar();
      return null;
    }
    render(h(Probe));
    const scroll = (y) => api.onScroll({ nativeEvent: { contentOffset: { y } } });
    globalThis.__springs = [];
    scroll(100);
    scroll(200);
    expect(api.collapse.value).toBe(1);
    scroll(150);
    expect(api.collapse.value).toBe(0);
    expect(globalThis.__springs).toEqual([1, 0]);
  });
});
