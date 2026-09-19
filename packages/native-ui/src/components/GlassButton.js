/**
 * The glass button — the one in Apple's Photos app: a translucent circle or
 * pill that lets you guess what it covers, a soft shadow, and a solid tint
 * when it carries the main action.
 *
 * A glass with depth: the icon is caught in it like an object in an ice cube
 * and comes out sharp (see `glassButtonMaterial`). Three layers, in this
 * order: the tint, the highlight, then the content. The content goes ABOVE
 * the highlight — a white veil over the icon would dim it.
 */
const { h, RN, LinearGradient, getGlassMode, useScheme } = require('./runtime');
const { GlassSurface } = require('./GlassSurface');
const { glassButtonMaterial, glassButtonTint } = require('../logic/glass');

/* The shadow is iOS's, where the glass carries it discreetly. On Android it
   became a full boxShadow under an almost white fill: a grey halo around
   every round button. Android gets none. */
const IOS_SHADOW = {
  shadowColor: '#0d1235',
  shadowOpacity: 0.1,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 }
};

const control = {
  flex: 1,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  paddingHorizontal: 12
};

/* The press is iOS's gesture; on Android the ripple is enough, and both
   together make a button that jerks. */
const PRESSED = { opacity: 0.75, transform: [{ scale: 0.96 }] };

function GlassButton({
  children,
  onPress,
  onLongPress,
  accessibilityLabel,
  size = 44,
  pill = false,
  tint,
  disabled = false,
  selected = false,
  scheme: schemeOverride,
  style,
  testID
}) {
  const scheme = useScheme(schemeOverride);
  const mode = getGlassMode();
  const material = glassButtonMaterial({ mode, scheme, tinted: Boolean(tint) });
  const android = RN.Platform.OS === 'android';
  return h(
    GlassSurface,
    {
      style: [
        android ? null : IOS_SHADOW,
        { height: size, borderRadius: size / 2, width: pill ? undefined : size },
        disabled ? { opacity: 0.5 } : null,
        style
      ],
      glassStyle: material.glassStyle,
      tintColor: tint || glassButtonTint({ mode, selected }),
      interactive: Boolean(onPress) && !disabled,
      scheme
    },
    /* Apple's glass ignores the fill it is given: a tinted button's colour is
       therefore a layer of its own, under the highlight. */
    tint
      ? h(RN.View, {
          pointerEvents: 'none',
          style: [RN.StyleSheet.absoluteFill, { backgroundColor: tint, opacity: 0.8 }]
        })
      : null,
    h(LinearGradient, {
      pointerEvents: 'none',
      colors: material.highlight,
      locations: [0, 0.55, 1],
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
      style: RN.StyleSheet.absoluteFill
    }),
    h(
      RN.Pressable,
      {
        testID,
        accessibilityRole: 'button',
        accessibilityLabel,
        accessibilityState: { disabled, selected },
        disabled,
        hitSlop: 6,
        onPress,
        onLongPress,
        /* Without it the button had no touch feedback at all on Android. The
           ripple is light on a tinted button, dark on a light one. */
        android_ripple: {
          color: tint ? 'rgba(255,255,255,0.24)' : 'rgba(13,18,53,0.10)',
          borderless: true,
          foreground: true
        },
        style: ({ pressed }) => [
          control,
          /* With no fill of its own, iOS casts this shadow onto the silhouette
             of the icon and text only: the glow that lifts them out. */
          material.glow,
          pressed && !android ? PRESSED : null
        ]
      },
      children
    )
  );
}

module.exports = { GlassButton };
