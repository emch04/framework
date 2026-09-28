/**
 * The picture components mounted over the react-native mocks (test/rn.js):
 * what the finger and the screen reader meet, what a gesture calls, what
 * "Reduce Motion" turns off.
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
const flush = () => act(async () => {});

beforeEach(() => {
  globalThis.__timings = [];
  globalThis.__repeats = [];
  globalThis.__cancels = [];
  globalThis.__springs = [];
  globalThis.__zooms = [];
  globalThis.__scrolledTo = [];
  globalThis.__pans = [];
  globalThis.__imageSize = undefined;
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  globalThis.__reduceMotion = false;
  globalThis.__scheme = 'light';
  globalThis.__platform = 'ios';
  globalThis.__windowWidth = undefined;
  globalThis.__scrollX = undefined;
});

describe('ImageShimmer', () => {
  test('one progress bar for the screen reader, the app\'s words, a light that keeps passing', () => {
    const { getByRole, container, getByText } = render(h(ui.ImageShimmer, { accessibilityLabel: 'Drawing', caption: 'Drawing…', ratio: 1.5 }));
    const bar = getByRole('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('Drawing');
    expect(props(bar).accessible).toBe(true);
    expect(byRn(container, 'LinearGradient')).toHaveLength(1);
    expect(globalThis.__repeats).toEqual([{ animation: 1, count: -1, reverse: false }]);
    expect(globalThis.__timings).toContainEqual({ to: 1, duration: ui.SHIMMER_PASS_MS });
    expect(style(bar.firstChild).aspectRatio).toBe(1.5);
    expect(getByText('Drawing…')).toBeTruthy();
  });

  test('flat: no outline, no shadow on the place held', () => {
    const { getByRole } = render(h(ui.ImageShimmer, { accessibilityLabel: 'x' }));
    const shape = style(getByRole('progressbar').firstChild);
    expect(shape.borderWidth).toBeUndefined();
    expect(shape.shadowOpacity).toBeUndefined();
    expect(shape.borderRadius).toBe(ui.PALE_CARD_RADIUS);
  });

  test('Reduce Motion: the shape stays, the light does not move', () => {
    globalThis.__reduceMotion = true;
    const { container, getByRole } = render(h(ui.ImageShimmer, { accessibilityLabel: 'x' }));
    expect(getByRole('progressbar')).toBeTruthy();
    expect(byRn(container, 'LinearGradient')).toHaveLength(0);
    expect(globalThis.__repeats).toEqual([]);
  });

  test('the light is stopped when the place goes', () => {
    const { unmount } = render(h(ui.ImageShimmer, { accessibilityLabel: 'x' }));
    unmount();
    expect(globalThis.__cancels.length).toBeGreaterThan(0);
  });

  test('the dark scheme and the app\'s colours', () => {
    globalThis.__scheme = 'dark';
    const { getByRole, rerender } = render(h(ui.ImageShimmer, { accessibilityLabel: 'x' }));
    const dark = style(getByRole('progressbar').firstChild).backgroundColor;
    rerender(h(ui.ImageShimmer, { accessibilityLabel: 'x', scheme: 'light' }));
    expect(style(getByRole('progressbar').firstChild).backgroundColor).not.toBe(dark);
    rerender(h(ui.ImageShimmer, { accessibilityLabel: 'x', colors: { base: '#123456' } }));
    expect(style(getByRole('progressbar').firstChild).backgroundColor).toBe('#123456');
  });
});

describe('AutoRatioImage', () => {
  const SOURCE = { uri: 'https://cdn.example.org/a.jpg' };

  test('a place with the light until the picture is there, then its own shape, revealed', () => {
    const onRatio = jest.fn();
    const { container, queryByRole } = render(h(ui.AutoRatioImage, { source: SOURCE, accessibilityLabel: 'Ark', loadingLabel: 'Loading', onRatio }));
    const frame = container.firstChild;
    expect(style(frame).aspectRatio).toBe(1);
    expect(queryByRole('progressbar').getAttribute('aria-label')).toBe('Loading');
    const [img] = byRn(container, 'Image');
    expect(props(img).source).toEqual(SOURCE);
    expect(props(img).resizeMode).toBe('contain');
    act(() => fireEvent.load(img));
    expect(props(container.firstChild).accessible).toBe(true);
    expect(style(container.firstChild).aspectRatio).toBeCloseTo(16 / 9);
    expect(onRatio).toHaveBeenCalledWith(1600 / 900);
    expect(queryByRole('progressbar')).toBeNull();
    expect(globalThis.__timings).toContainEqual({ to: 1, duration: ui.PICTURE_REVEAL.durationMs });
    expect(style(container.firstChild).backgroundColor).toBe('transparent');
    expect(container.firstChild.getAttribute('role')).toBe('image');
    expect(container.firstChild.getAttribute('aria-label')).toBe('Ark');
  });

  test('Reduce Motion: the picture is there at once, no reveal', () => {
    globalThis.__reduceMotion = true;
    const { container } = render(h(ui.AutoRatioImage, { source: SOURCE }));
    act(() => fireEvent.load(byRn(container, 'Image')[0]));
    expect(globalThis.__timings.filter((t) => t.duration === ui.PICTURE_REVEAL.durationMs)).toEqual([]);
  });

  test('a strip does not make a view ten thousand points tall', () => {
    globalThis.__imageSize = { width: 10, height: 100000 };
    const { container } = render(h(ui.AutoRatioImage, { source: SOURCE }));
    act(() => fireEvent.load(byRn(container, 'Image')[0]));
    expect(style(container.firstChild).aspectRatio).toBe(ui.PICTURE_RATIO_LIMITS.min);
  });

  test('a fetched source (with its headers) is loaded once per picture, not once per render', async () => {
    const load = jest.fn(async () => ({ uri: 'https://app.example.com/images/a', headers: { Authorization: 'Bearer t' } }));
    const { container, rerender } = render(h(ui.AutoRatioImage, { load, sourceKey: 'a' }));
    await flush();
    expect(props(byRn(container, 'Image')[0]).source.headers).toEqual({ Authorization: 'Bearer t' });
    rerender(h(ui.AutoRatioImage, { load: () => load(), sourceKey: 'a' }));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    rerender(h(ui.AutoRatioImage, { load, sourceKey: 'b' }));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('a load that fails shows the app\'s error slot — never a spinner forever — and can retry', async () => {
    const load = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(SOURCE);
    const onError = jest.fn();
    const { getByText, queryByRole, container } = render(
      h(ui.AutoRatioImage, {
        load,
        sourceKey: 'a',
        onError,
        renderError: ({ retry }) => h(RN().Pressable, { onPress: retry, accessibilityRole: 'button' }, h(RN().Text, null, 'Retry'))
      })
    );
    await flush();
    expect(getByText('Retry')).toBeTruthy();
    /* The frame no longer groups its content: the retry button is reachable on its own. */
    expect(props(container.firstChild).accessible).toBe(false);
    expect(queryByRole('progressbar')).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }));
    fireEvent.click(getByText('Retry').parentElement);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(byRn(container, 'Image')).toHaveLength(1);
  });

  test('a load that resolves nothing is a failure too', async () => {
    const { getByText } = render(h(ui.AutoRatioImage, { load: async () => null, sourceKey: 'a', renderError: () => 'Failed' }));
    await flush();
    expect(getByText('Failed')).toBeTruthy();
  });

  test('a picture that does not decode shows the error slot', () => {
    const onError = jest.fn();
    const { container, getByText } = render(h(ui.AutoRatioImage, { source: SOURCE, onError, renderError: () => 'Failed' }));
    act(() => fireEvent.error(byRn(container, 'Image')[0]));
    expect(getByText('Failed')).toBeTruthy();
    expect(onError).toHaveBeenCalledWith('failed');
  });

  test('a new picture starts over: the previous one\'s shape and failure do not stay', () => {
    const { container, rerender, queryByText } = render(h(ui.AutoRatioImage, { source: SOURCE, renderError: () => 'Failed' }));
    act(() => fireEvent.load(byRn(container, 'Image')[0]));
    expect(style(container.firstChild).aspectRatio).toBeCloseTo(16 / 9);
    rerender(h(ui.AutoRatioImage, { source: { uri: 'https://cdn.example.org/b.jpg' }, renderError: () => 'Failed' }));
    expect(style(container.firstChild).aspectRatio).toBe(1);
    act(() => fireEvent.error(byRn(container, 'Image')[0]));
    expect(queryByText('Failed')).toBeTruthy();
    rerender(h(ui.AutoRatioImage, { source: { uri: 'https://cdn.example.org/c.jpg' }, renderError: () => 'Failed' }));
    expect(queryByText('Failed')).toBeNull();
  });

  test('no source at all is a failure, not a wait', () => {
    const { getByText } = render(h(ui.AutoRatioImage, { source: null, renderError: () => 'Failed' }));
    expect(getByText('Failed')).toBeTruthy();
  });

  test('tappable: an image button, only once the picture is there, pressed on a spring', () => {
    const onPress = jest.fn();
    const { container, getByRole } = render(
      h(ui.AutoRatioImage, { source: SOURCE, onPress, accessibilityLabel: 'Ark', accessibilityHint: 'Opens full screen' })
    );
    const button = getByRole('imagebutton');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
    act(() => fireEvent.load(byRn(container, 'Image')[0]));
    expect(getByRole('imagebutton').getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(getByRole('imagebutton'));
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(getByRole('imagebutton'));
    fireEvent.mouseUp(getByRole('imagebutton'));
    expect(globalThis.__springs).toEqual([1, 0]);
  });

  test('another image component (expo-image) gets contentFit and its size read from its own event', () => {
    function ExpoImage(p) {
      return h('img', {
        'data-rn': 'ExpoImage',
        'data-props': JSON.stringify({ contentFit: p.contentFit, resizeMode: p.resizeMode, cachePolicy: p.cachePolicy }),
        onLoad: () => p.onLoad({ source: { width: 300, height: 600 } })
      });
    }
    const { container } = render(h(ui.AutoRatioImage, { source: SOURCE, ImageComponent: ExpoImage, imageProps: { cachePolicy: 'disk' } }));
    const [img] = byRn(container, 'ExpoImage');
    expect(props(img)).toEqual({ contentFit: 'contain', cachePolicy: 'disk' });
    act(() => fireEvent.load(img));
    expect(style(container.firstChild).aspectRatio).toBe(0.5);
  });
});

function RN() {
  return require('react-native');
}

describe('ImageViewer', () => {
  const PICTURES = [
    { key: 'a', url: '/images/a', title: 'First' },
    { key: 'b', url: '/images/b', title: 'Second' },
    { key: 'c', url: 'https://cdn.example.org/c.jpg', title: 'Third' }
  ];
  const labels = { close: 'Close', share: 'Share', details: 'Details', counter: (position, count) => `${position} of ${count}`, zoomHint: 'Double-tap to zoom' };
  const icons = { close: h('i', { id: 'close' }), share: h('i', { id: 'share' }), details: h('i', { id: 'info' }), failed: h('i', { id: 'failed' }) };
  const resolveSource = jest.fn(async (picture) =>
    picture.url.startsWith('/') ? { uri: `https://app.example.com${picture.url}`, headers: { Authorization: 'Bearer t' } } : { uri: picture.url }
  );
  const mount = async (extra = {}) => {
    const view = render(h(ui.ImageViewer, { pictures: PICTURES, start: 1, onClose: jest.fn(), resolveSource, labels, icons, ...extra }));
    await flush();
    return view;
  };
  const dismissConfig = () => globalThis.__pans[globalThis.__pans.length - 1];

  test('closed: nothing is drawn', () => {
    const { container } = render(h(ui.ImageViewer, { pictures: PICTURES, start: null, onClose: () => {}, labels, icons }));
    expect(container.innerHTML).toBe('');
  });

  test('open on the picture asked, each page resolved by the APP (headers included), words from the app', async () => {
    const { container, getByText, getByTestId } = await mount();
    expect(props(byRn(container, 'FlatList')[0]).initialScrollIndex).toBe(1);
    expect(getByText('2 of 3')).toBeTruthy();
    expect(getByText('Second')).toBeTruthy();
    expect(getByTestId('viewer-close').getAttribute('aria-label')).toBe('Close');
    const sources = byRn(container, 'Image').map((img) => props(img).source);
    expect(sources).toContainEqual({ uri: 'https://app.example.com/images/a', headers: { Authorization: 'Bearer t' } });
    expect(sources).toContainEqual({ uri: 'https://cdn.example.org/c.jpg' });
    const page = byRn(container, 'Pressable').find((el) => el.getAttribute('aria-label') === 'Second');
    expect(page.getAttribute('role')).toBe('image');
    expect(props(page).accessibilityIgnoresInvertColors).toBeUndefined();
    expect(globalThis.__modal.onRequestClose).toBeDefined();
    expect(globalThis.__modal.animationType).toBe('fade');
  });

  test('a start past the end opens on the last picture', async () => {
    const { container, getByText } = await mount({ start: 9 });
    expect(props(byRn(container, 'FlatList')[0]).initialScrollIndex).toBe(2);
    expect(getByText('3 of 3')).toBeTruthy();
  });

  test('one picture: no counter', async () => {
    const { queryByText } = await mount({ pictures: [PICTURES[0]], start: 0 });
    expect(queryByText('1 of 1')).toBeNull();
  });

  test('controls are round glass buttons', async () => {
    const { container } = await mount({ onShare: jest.fn() });
    const glass = byRn(container, 'GlassView').filter((el) => style(el).width === 44);
    expect(glass.length).toBeGreaterThanOrEqual(2);
    for (const button of glass) expect(style(button)).toMatchObject({ width: 44, height: 44, borderRadius: 22 });
  });

  test('share goes through the app\'s hook with the picture shown; its notice is shown a moment', async () => {
    jest.useFakeTimers();
    const onShare = jest.fn(async () => 'Shared');
    const onHaptic = jest.fn();
    const { getByTestId, queryByText } = await mount({ onShare, onHaptic });
    await act(async () => {
      fireEvent.click(getByTestId('viewer-action-share'));
    });
    expect(onShare).toHaveBeenCalledWith(PICTURES[1]);
    expect(queryByText('Shared')).toBeTruthy();
    expect(onHaptic).toHaveBeenCalledWith('success');
    act(() => jest.advanceTimersByTime(ui.VIEWER_GESTURES.noticeMs));
    expect(queryByText('Shared')).toBeNull();
  });

  test('while an action runs, it spins and the others wait', async () => {
    let finish;
    const save = { key: 'save', label: 'Save', icon: h('i'), onPress: jest.fn(() => new Promise((resolve) => (finish = resolve))) };
    const { getByTestId, container } = await mount({ onShare: jest.fn(), actions: [save] });
    await act(async () => {
      fireEvent.click(getByTestId('viewer-action-save'));
    });
    expect(byRn(getByTestId('viewer-action-save'), 'ActivityIndicator')).toHaveLength(1);
    expect(getByTestId('viewer-action-share').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(getByTestId('viewer-action-save'));
    expect(save.onPress).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(byRn(container, 'ActivityIndicator').filter((el) => el.closest('[data-testid="viewer-action-save"]'))).toHaveLength(0);
  });

  test('a failed action goes to the app, with its key and picture', async () => {
    const onActionError = jest.fn();
    const onHaptic = jest.fn();
    const error = new Error('denied');
    const { getByTestId } = await mount({ actions: [{ key: 'save', label: 'Save', icon: h('i'), onPress: async () => Promise.reject(error) }], onActionError, onHaptic });
    await act(async () => {
      fireEvent.click(getByTestId('viewer-action-save'));
    });
    expect(onActionError).toHaveBeenCalledWith(error, 'save', PICTURES[1]);
    expect(onHaptic).toHaveBeenCalledWith('failure');
  });

  test('a swipe to another page: the counter follows, the app is told', async () => {
    const onIndexChange = jest.fn();
    const onHaptic = jest.fn();
    const { container, getByText } = await mount({ onIndexChange, onHaptic });
    globalThis.__scrollX = 780; // width 390 × 2
    fireEvent.scroll(byRn(container, 'FlatList')[0]);
    expect(getByText('3 of 3')).toBeTruthy();
    expect(getByText('Third')).toBeTruthy();
    expect(onIndexChange).toHaveBeenCalledWith(2);
    expect(onHaptic).toHaveBeenCalledWith('selection');
  });

  test('pull down to close: a vertical pull is captured, a far release closes', async () => {
    const onClose = jest.fn();
    const onHaptic = jest.fn();
    await mount({ onClose, onHaptic });
    const pan = dismissConfig();
    const touch = { nativeEvent: { touches: [{}] } };
    expect(pan.onMoveShouldSetPanResponderCapture(touch, { dx: 0, dy: 30 })).toBe(true);
    expect(pan.onMoveShouldSetPanResponderCapture(touch, { dx: 40, dy: 30 })).toBe(false);
    expect(pan.onMoveShouldSetPanResponderCapture({ nativeEvent: { touches: [{}, {}] } }, { dx: 0, dy: 30 })).toBe(false);
    act(() => pan.onPanResponderMove(touch, { dy: 60 }));
    act(() => pan.onPanResponderRelease(touch, { dy: 60, vy: 0.1 }));
    expect(onClose).not.toHaveBeenCalled();
    expect(globalThis.__springs).toContain(0);
    act(() => pan.onPanResponderRelease(touch, { dy: 200, vy: 0.1 }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onHaptic).toHaveBeenCalledWith('impact');
    expect(globalThis.__timings).toContainEqual({ to: 844, duration: ui.VIEWER_GESTURES.closeMs });
  });

  test('Reduce Motion: opens and closes at once, the pull springs nowhere', async () => {
    globalThis.__reduceMotion = true;
    const onClose = jest.fn();
    await mount({ onClose });
    expect(globalThis.__modal.animationType).toBe('none');
    const pan = dismissConfig();
    globalThis.__timings = [];
    globalThis.__springs = [];
    act(() => pan.onPanResponderRelease({}, { dy: 40, vy: 0 }));
    expect(globalThis.__springs).toEqual([]);
    act(() => pan.onPanResponderRelease({}, { dy: 400, vy: 0 }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(globalThis.__timings.filter((t) => t.duration === ui.VIEWER_GESTURES.closeMs)).toEqual([]);
  });

  test('a single tap hides the controls — for the eye and the screen reader — and the status bar; another brings them back', async () => {
    jest.useFakeTimers();
    const { container, getByTestId } = await mount();
    const page = () => byRn(container, 'Pressable').find((el) => el.getAttribute('aria-label') === 'Second');
    fireEvent.click(page());
    act(() => jest.advanceTimersByTime(ui.VIEWER_GESTURES.doubleTapMs));
    const top = getByTestId('viewer-close').closest('[data-rn="Animated.View"]');
    /* accessibilityElementsHidden (iOS) is an accessibility prop the mock does not echo; its Android twin is. */
    expect(props(top)).toMatchObject({ pointerEvents: 'none', importantForAccessibility: 'no-hide-descendants' });
    expect(props(byRn(container, 'StatusBar')[0]).hidden).toBe(true);
    fireEvent.click(page());
    act(() => jest.advanceTimersByTime(ui.VIEWER_GESTURES.doubleTapMs));
    expect(props(getByTestId('viewer-close').closest('[data-rn="Animated.View"]')).pointerEvents).toBe('box-none');
  });

  test('iOS: a double tap zooms where it lands (and does not toggle the controls)', async () => {
    jest.useFakeTimers();
    const { container, getByTestId } = await mount();
    const page = byRn(container, 'Pressable').find((el) => el.getAttribute('aria-label') === 'Second');
    globalThis.__tapX = 100;
    globalThis.__tapY = 200;
    fireEvent.click(page);
    fireEvent.click(page);
    act(() => jest.advanceTimersByTime(500));
    expect(globalThis.__zooms).toEqual([{ ...ui.zoomRect({ x: 100, y: 200 }, { width: 390, height: 844 }, 2.5), animated: true }]);
    expect(props(getByTestId('viewer-close').closest('[data-rn="Animated.View"]')).pointerEvents).toBe('box-none');
    globalThis.__tapX = undefined;
    globalThis.__tapY = undefined;
  });

  test('Android: two fingers zoom, the pages then stay put and no pull starts; a double tap zooms back out', async () => {
    globalThis.__platform = 'android';
    jest.useFakeTimers();
    const { container } = await mount({ pictures: [PICTURES[0]], start: 0 });
    const [dismiss, page] = globalThis.__pans.slice(-2);
    const two = (spread) => ({ nativeEvent: { touches: [{ pageX: 195 - spread, pageY: 422 }, { pageX: 195 + spread, pageY: 422 }] } });
    expect(page.onMoveShouldSetPanResponder(two(20))).toBe(true);
    expect(page.onMoveShouldSetPanResponder({ nativeEvent: { touches: [{}] } })).toBe(false);
    act(() => page.onPanResponderGrant());
    act(() => page.onPanResponderMove(two(20), { dx: 0, dy: 0 }));
    act(() => page.onPanResponderMove(two(60), { dx: 0, dy: 0 }));
    act(() => page.onPanResponderRelease(two(60)));
    expect(props(byRn(container, 'FlatList')[0]).scrollEnabled).toBe(false);
    expect(page.onPanResponderTerminationRequest()).toBe(false);
    expect(dismiss.onMoveShouldSetPanResponderCapture({ nativeEvent: { touches: [{}] } }, { dx: 0, dy: 50 })).toBe(false);
    /* Zoomed ×3: one finger now moves the picture, without leaving its bounds. */
    expect(page.onMoveShouldSetPanResponder({ nativeEvent: { touches: [{}] } })).toBe(true);
    /* A double tap: two releases without movement. */
    const still = { nativeEvent: { locationX: 100, locationY: 100 } };
    act(() => page.onPanResponderGrant());
    act(() => page.onPanResponderRelease(still));
    act(() => page.onPanResponderGrant());
    act(() => page.onPanResponderRelease(still));
    expect(props(byRn(container, 'FlatList')[0]).scrollEnabled).toBe(true);
  });

  test('Android: a double tap zooms in at the tap, a pinch past the bounds settles back', async () => {
    globalThis.__platform = 'android';
    jest.useFakeTimers();
    const { container } = await mount({ pictures: [PICTURES[0]], start: 0 });
    const [, page] = globalThis.__pans.slice(-2);
    const still = { nativeEvent: { locationX: 100, locationY: 100 } };
    act(() => page.onPanResponderGrant());
    act(() => page.onPanResponderRelease(still));
    act(() => page.onPanResponderGrant());
    act(() => page.onPanResponderRelease(still));
    expect(props(byRn(container, 'FlatList')[0]).scrollEnabled).toBe(false);
    const expected = ui.zoomAt({ x: 100, y: 100 }, { width: 390, height: 844 }, 2.5);
    expect(globalThis.__timings).toEqual(expect.arrayContaining([{ to: expected.scale, duration: 240 }, { to: expected.x, duration: 240 }]));
    globalThis.__timings = [];
    const two = (spread) => ({ nativeEvent: { touches: [{ pageX: 195 - spread, pageY: 422 }, { pageX: 195 + spread, pageY: 422 }] } });
    act(() => page.onPanResponderGrant());
    act(() => page.onPanResponderMove(two(10), { dx: 0, dy: 0 }));
    act(() => page.onPanResponderMove(two(100), { dx: 0, dy: 0 }));
    act(() => page.onPanResponderRelease(two(100)));
    expect(globalThis.__timings).toContainEqual({ to: ui.VIEWER_GESTURES.maxZoom, duration: 240 });
  });

  test('a picture that cannot be resolved shows the app\'s failed icon, not a spinner', async () => {
    const { container } = await mount({ resolveSource: async () => Promise.reject(new Error('refused')), pictures: [PICTURES[0]], start: 0 });
    expect(container.querySelector('#failed')).not.toBeNull();
    expect(byRn(container, 'ActivityIndicator')).toHaveLength(0);
  });

  test('without resolveSource, the picture\'s own source is used', async () => {
    const { container } = await mount({ resolveSource: undefined, pictures: [{ key: 'x', source: { uri: 'https://cdn.example.org/x.jpg' } }], start: 0 });
    expect(props(byRn(container, 'Image')[0]).source).toEqual({ uri: 'https://cdn.example.org/x.jpg' });
  });

  test('the details replace the title while asked', async () => {
    const { getByTestId, queryByText } = await mount({ renderDetails: (picture) => h(RN().Text, null, `About ${picture.title}`) });
    expect(queryByText('About Second')).toBeNull();
    fireEvent.click(getByTestId('viewer-details'));
    expect(queryByText('About Second')).toBeTruthy();
    expect(queryByText('Second')).toBeNull();
  });

  test('the last picture removed while open closes the viewer', async () => {
    const onClose = jest.fn();
    const { rerender } = await mount({ onClose });
    rerender(h(ui.ImageViewer, { pictures: [], start: 1, onClose, resolveSource, labels, icons }));
    expect(onClose).toHaveBeenCalled();
  });

  test('a rotation puts the list back on the same picture', async () => {
    const view = await mount();
    globalThis.__windowWidth = 844;
    view.rerender(h(ui.ImageViewer, { pictures: PICTURES, start: 1, onClose: jest.fn(), resolveSource, labels, icons }));
    expect(globalThis.__scrolledTo).toEqual([{ index: 1, animated: false }]);
  });

  test('the safe area is kept clear', async () => {
    const { getByTestId } = await mount({ insets: { top: 47, bottom: 34 }, onShare: jest.fn() });
    expect(style(getByTestId('viewer-close').closest('[data-rn="Animated.View"]')).top).toBe(55);
    expect(style(getByTestId('viewer-action-share').closest('[data-rn="Animated.View"]')).bottom).toBe(46);
  });
});
