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
 * __probes (how many times Apple's glass API was probed).
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
    if (onPress) attrs.onClick = () => (disabled ? undefined : onPress());
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
    ScrollView: host('ScrollView'),
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
