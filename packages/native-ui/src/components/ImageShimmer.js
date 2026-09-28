/**
 * The place a picture will take while it is being made or fetched: a rounded
 * shape at the picture's proportions, where a soft light passes left to right,
 * and an optional quiet caption beneath.
 *
 * The screen reader hears one element, a progress bar with the app's label
 * ("Drawing the picture…"). "Reduce Motion": the light does not move — the
 * shape stays, still.
 */
const { React, h, RN, LinearGradient, Reanimated, AnimatedView, useReducedMotion, useScheme } = require('./runtime');
const { SHIMMER_PASS_MS, shimmerTranslate } = require('../logic/picture');
const { PALE_CARD_RADIUS } = require('../logic/paleCard');

/* Destructured once: a worklet must capture what it calls itself. */
const { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } = Reanimated;

/* A flat ground with no outline, and a light only a little brighter: the
   placeholder is a presence, not a signal. The app's own theme passes its
   colours in `colors`. */
const DEFAULT_COLORS = {
  light: { base: '#eef0f5', light: 'rgba(255,255,255,0.85)', caption: 'rgba(60,60,67,0.6)' },
  dark: { base: '#1c1c1e', light: 'rgba(255,255,255,0.08)', caption: 'rgba(235,235,245,0.6)' }
};

function ImageShimmer({
  ratio = 1,
  borderRadius = PALE_CARD_RADIUS,
  colors,
  accessibilityLabel,
  caption,
  captionStyle,
  passMs = SHIMMER_PASS_MS,
  scheme: schemeOverride,
  style,
  testID
}) {
  const scheme = useScheme(schemeOverride);
  const palette = { ...DEFAULT_COLORS[scheme], ...(colors || {}) };
  const reduceMotion = useReducedMotion();
  const position = useSharedValue(0);

  React.useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(position);
      position.value = 0;
      return undefined;
    }
    position.value = withRepeat(withTiming(1, { duration: passMs, easing: Easing.inOut(Easing.quad) }), -1, false);
    return () => cancelAnimation(position);
  }, [reduceMotion, passMs, position]);

  const light = useAnimatedStyle(() => ({ transform: [{ translateX: shimmerTranslate(position.value) }] }));

  return h(
    RN.View,
    {
      testID,
      accessible: true,
      accessibilityRole: 'progressbar',
      accessibilityLabel,
      accessibilityState: { busy: true },
      style: [{ gap: 8 }, style]
    },
    h(
      RN.View,
      {
        style: {
          aspectRatio: ratio > 0 ? ratio : 1,
          borderRadius,
          overflow: 'hidden',
          backgroundColor: palette.base
        }
      },
      reduceMotion
        ? null
        : h(
            AnimatedView,
            { pointerEvents: 'none', style: [RN.StyleSheet.absoluteFill, light] },
            h(LinearGradient, {
              colors: ['transparent', palette.light, 'transparent'],
              start: { x: 0, y: 0.35 },
              end: { x: 1, y: 0.65 },
              style: RN.StyleSheet.absoluteFill
            })
          )
    ),
    caption ? h(RN.Text, { style: [{ fontSize: 13, color: palette.caption }, captionStyle] }, caption) : null
  );
}

module.exports = { ImageShimmer };
