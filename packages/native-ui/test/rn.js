/**
 * Mocks of the react-native peers, rendering to the DOM.
 *
 * Every host component becomes an element whose props are readable:
 *   data-rn        the component name (View, Text, GlassView, LinearGradient…)
 *   data-testid    testID
 *   role, aria-*   accessibilityRole / Label / State
 *   data-style     the flattened style, as JSON
 *   data-props     the other serialisable props, as JSON
 * `onPress` becomes a click; `onLayout` fires once after mount with a width
 * taken from `globalThis.__layoutWidth` (default 300); a DOM `scroll` event
 * calls `onScroll` at the offset `globalThis.__scrollY`.
 *
 * Device facts are globals the test sets BEFORE requiring the kit:
 *   __platform ('ios'), __liquidGlass (true), __scheme ('light'),
 *   __windowWidth (390), __reduceMotion (false), __fontScale (1).
 * Recorded calls: __springs (withSpring targets), __links (openURL),
 * __probes (how many times Apple's glass API was probed), __timings
 * (withTiming targets), __repeats (withRepeat calls), __cancels
 * (cancelAnimation calls), __zooms (ScrollView.scrollResponderZoomTo),
 * __scrolledTo (FlatList.scrollToIndex), __pans (PanResponder configs, in
 * creation order — a test calls their handlers directly).
 *
 * A press carries `{ nativeEvent: { locationX: __tapX, locationY: __tapY } }`.
 * Image is an <img>: `fireEvent.load` calls onLoad with a React Native event
 * whose size is `__imageSize` (1600×900 by default), `fireEvent.error` calls
 * onError. Modal renders its children only while visible. FlatList renders
 * every item; a DOM `scroll` event on it calls onMomentumScrollEnd at the
 * offset `__scrollX`.
 */
const React = require('react');

const h = React.createElement;

function flatten(style) {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? style : {};
}

function serialisable(value) {
  if (typeof value === 'function' || value === undefined) return false;
  if (React.isValidElement(value)) return false;
  return true;
}

const SKIP = new Set(['children', 'style', 'testID', 'onPress', 'onLayout', 'onScroll', 'ref', 'maskElement', 'contentContainerStyle']);

function hostProps(name, props) {
  const out = { 'data-rn': name };
  if (props.testID) out['data-testid'] = props.testID;
  if (props.accessibilityRole) out.role = props.accessibilityRole;
  if (props.accessibilityLabel) out['aria-label'] = props.accessibilityLabel;
  const state = props.accessibilityState || {};
  if (state.selected !== undefined) out['aria-selected'] = String(state.selected);
  if (state.disabled !== undefined) out['aria-disabled'] = String(state.disabled);
  const style = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
  out['data-style'] = JSON.stringify(flatten(style));
  const rest = {};
  for (const [key, value] of Object.entries(props)) {
    if (SKIP.has(key) || key.startsWith('accessibility') || !serialisable(value)) continue;
    rest[key] = value;
  }
  out['data-props'] = JSON.stringify(rest);
  return out;
}

function host(name, tag = 'div') {
  function Host(props) {
    const { onLayout, onPress, disabled } = props;
    React.useEffect(() => {
      if (onLayout) {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: globalThis.__layoutWidth ?? 300, height: 40 } } });
      }
    }, []); // once, after mount: a layout pass, not a subscription
    const attrs = hostProps(name, props);
    if (onPress) {
      attrs.onClick = () =>
        disabled
          ? undefined
          : onPress({ nativeEvent: { locationX: globalThis.__tapX ?? 0, locationY: globalThis.__tapY ?? 0 } });
    }
    /* The finger down and up, as a mouse press. */
    if (props.onPressIn) attrs.onMouseDown = () => (disabled ? undefined : props.onPressIn());
    if (props.onPressOut) attrs.onMouseUp = () => (disabled ? undefined : props.onPressOut());
    if (props.onScroll) {
      attrs.onScroll = () =>
        props.onScroll({
          nativeEvent: {
            contentOffset: { x: 0, y: globalThis.__scrollY ?? 0 },
            contentSize: { width: 0, height: 0 },
            layoutMeasurement: { width: 0, height: 0 }
          }
        });
    }
    const children = typeof props.children === 'function' ? props.children({ pressed: false }) : props.children;
    const mask = props.maskElement ? h('div', { 'data-rn': 'mask' }, props.maskElement) : null;
    return h(tag, attrs, mask, children);
  }
  Host.displayName = name;
  return Host;
}

const View = host('View');
const Text = host('Text', 'span');

function Image(props) {
  const attrs = hostProps('Image', props);
  attrs.onLoad = () => {
    const size = globalThis.__imageSize || { width: 1600, height: 900 };
    if (props.onLoad) props.onLoad({ nativeEvent: { source: { ...size, uri: props.source && props.source.uri } } });
  };
  attrs.onError = () => {
    if (props.onError) props.onError({ nativeEvent: { error: 'failed' } });
  };
  return h('img', attrs);
}

const BaseScrollView = host('ScrollView');
function ScrollView(props) {
  React.useImperativeHandle(props.ref, () => ({
    scrollResponderZoomTo: (rect) => (globalThis.__zooms = globalThis.__zooms || []).push(rect),
    scrollTo: () => {}
  }));
  return h(BaseScrollView, props);
}

function Modal(props) {
  if (!props.visible) return null;
  globalThis.__modal = props;
  return h('div', hostProps('Modal', props), props.children);
}

function FlatList(props) {
  React.useImperativeHandle(props.ref, () => ({
    scrollToIndex: (options) => (globalThis.__scrolledTo = globalThis.__scrolledTo || []).push(options)
  }));
  const attrs = hostProps('FlatList', props);
  attrs.onScroll = () => {
    if (props.onMomentumScrollEnd) {
      props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: globalThis.__scrollX ?? 0, y: 0 } } });
    }
  };
  const data = props.data || [];
  return h(
    'div',
    attrs,
    data.map((item, index) =>
      h(React.Fragment, { key: props.keyExtractor ? props.keyExtractor(item, index) : index }, props.renderItem({ item, index }))
    )
  );
}

const PanResponder = {
  create(config) {
    const pans = (globalThis.__pans = globalThis.__pans || []);
    pans.push(config);
    return { panHandlers: { 'data-pan': pans.length - 1 } };
  }
};

function reactNative() {
  class AnimatedValue {
    constructor(value) {
      this.value = value;
    }
    interpolate() {
      return this;
    }
  }
  return {
    View,
    Text,
    Pressable: host('Pressable'),
    ScrollView,
    Image,
    Modal,
    FlatList,
    PanResponder,
    StatusBar: host('StatusBar'),
    ActivityIndicator: host('ActivityIndicator'),
    Animated: {
      View,
      Value: AnimatedValue,
      spring: () => ({ start: () => {} })
    },
    StyleSheet: {
      create: (styles) => styles,
      flatten,
      hairlineWidth: 0.5,
      absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
    },
    Platform: {
      get OS() {
        return globalThis.__platform || 'ios';
      },
      select(options) {
        const os = globalThis.__platform || 'ios';
        return os in options ? options[os] : options.default;
      }
    },
    useWindowDimensions: () => ({ width: globalThis.__windowWidth ?? 390, height: 844 }),
    useColorScheme: () => globalThis.__scheme || 'light',
    Linking: {
      openURL: (url) => {
        (globalThis.__links = globalThis.__links || []).push(url);
        return Promise.resolve();
      }
    },
    PixelRatio: {
      getFontScale: () => globalThis.__fontScale ?? 1,
      roundToNearestPixel: (value) => Math.round(value * 3) / 3
    }
  };
}

function interpolate(value, input, output, clamp) {
  const [i0, i1] = input;
  const [o0, o1] = output;
  let t = i1 === i0 ? 0 : (value - i0) / (i1 - i0);
  if (clamp === 'clamp') t = Math.min(1, Math.max(0, t));
  return o0 + (o1 - o0) * t;
}

function reanimated() {
  const animated = { View: host('Animated.View'), Text: host('Animated.Text', 'span') };
  return {
    __esModule: true,
    default: animated,
    ...animated,
    useSharedValue: (initial) => React.useRef({ value: initial }).current,
    useAnimatedStyle: (worklet) => worklet(),
    withSpring: (to) => {
      (globalThis.__springs = globalThis.__springs || []).push(to);
      return to;
    },
    /* A timing lands at once; its end callback runs, as it would on completion. */
    withTiming: (to, config, done) => {
      (globalThis.__timings = globalThis.__timings || []).push({ to, duration: config && config.duration });
      if (typeof done === 'function') done(true);
      return to;
    },
    withRepeat: (animation, count, reverse) => {
      (globalThis.__repeats = globalThis.__repeats || []).push({ animation, count, reverse });
      return animation;
    },
    cancelAnimation: (shared) => {
      (globalThis.__cancels = globalThis.__cancels || []).push(shared);
    },
    runOnJS: (fn) => fn,
    Easing: {
      linear: (t) => t,
      quad: (t) => t * t,
      cubic: (t) => t * t * t,
      in: (f) => f,
      out: (f) => f,
      inOut: (f) => f
    },
    interpolate,
    useReducedMotion: () => Boolean(globalThis.__reduceMotion)
  };
}

function glassEffect() {
  const available = () => {
    globalThis.__probes = (globalThis.__probes || 0) + 1;
    return globalThis.__liquidGlass !== false;
  };
  return {
    GlassView: host('GlassView'),
    GlassContainer: host('GlassContainer'),
    isGlassEffectAPIAvailable: available,
    isLiquidGlassAvailable: available
  };
}

module.exports = {
  reactNative,
  reanimated,
  glassEffect,
  blur: () => ({ BlurView: host('BlurView') }),
  linearGradient: () => ({ LinearGradient: host('LinearGradient') })
};
