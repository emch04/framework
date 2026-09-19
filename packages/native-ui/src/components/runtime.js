/**
 * The peer modules, loaded once, and the device facts the kit reads from them.
 *
 * Every component goes through here instead of requiring react-native itself:
 * one place knows how a default export arrives (Metro's interop wraps an ES
 * module's default in `.default`, Node's require does not), and one place
 * decides the glass mode.
 */
const React = require('react');
const RN = require('react-native');
const { resolveGlassMode } = require('@astratra/native');

const h = React.createElement;

function interop(mod) {
  return mod && mod.default ? mod.default : mod;
}

const Reanimated = require('react-native-reanimated');
const AnimatedLib = interop(Reanimated);
const GlassEffect = require('expo-glass-effect');
const { LinearGradient } = require('expo-linear-gradient');
const { BlurView } = require('expo-blur');

/**
 * Probing the glass API THROWS off iOS on some versions of expo-glass-effect,
 * instead of answering false. A probe that throws is answered "no".
 */
function probe(fn) {
  try {
    return typeof fn === 'function' ? Boolean(fn()) : false;
  } catch (_error) {
    return false;
  }
}

let cachedMode = null;

/**
 * The glass this device renders, decided once for the whole app: a header
 * that is glass above a tab bar that is not reads worse than neither.
 *
 * Only `'native'` matters to this kit (see logic/glass.js for why Android's
 * `'blur'` is not used for surfaces). `isLiquidGlassAvailable` is the iOS 26
 * material itself; `isGlassEffectAPIAvailable` only says the module is there.
 */
function getGlassMode() {
  if (cachedMode) return cachedMode;
  const ios = RN.Platform.OS === 'ios';
  cachedMode = resolveGlassMode({
    platform: RN.Platform.OS,
    apiAvailable: ios && probe(GlassEffect.isGlassEffectAPIAvailable),
    effectAvailable: ios && probe(GlassEffect.isLiquidGlassAvailable)
  });
  return cachedMode;
}

/**
 * The colour scheme a component should draw for: the caller's (the APP's
 * theme — an app with its own dark mode) when given, the phone's otherwise.
 * Glass left in light mode on a dark page makes its labels unreadable.
 */
function useScheme(override) {
  const system = RN.useColorScheme();
  if (override === 'dark' || override === 'light') return override;
  return system === 'dark' ? 'dark' : 'light';
}

/** Reanimated's own "Reduce motion" reading; absent on old versions. */
function useReducedMotion() {
  const hook = Reanimated.useReducedMotion;
  return typeof hook === 'function' ? Boolean(hook()) : false;
}

module.exports = {
  React,
  RN,
  h,
  Reanimated,
  AnimatedView: AnimatedLib.View,
  AnimatedText: AnimatedLib.Text,
  GlassEffect,
  LinearGradient,
  BlurView,
  getGlassMode,
  useScheme,
  useReducedMotion
};
