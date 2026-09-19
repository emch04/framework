/**
 * The glass rules, decided without react-native so they test dry.
 *
 * WHICH GLASS. The device's glass mode comes from `resolveGlassMode` in
 * `@astratra/native` — one rule for the whole Astratra stack, not a second
 * copy here. This kit only ever asks one question of it: is the answer
 * `'native'` (Apple's own Liquid Glass material)?
 *
 * Everything else — Android, an iPhone below iOS 26, the web — gets a VISIBLE
 * SURFACE, not an imitation. That was learnt the hard way. Android was first
 * given its native backdrop blur (`dimezisBlurView`, the `'blur'` answer):
 * the blur worked, but it imitated a material that does not exist on Android.
 * It captures the view hierarchy and re-blurs it every frame, and the result
 * looked neither like Apple's glass nor like Material — a dense, opaque grey,
 * obvious on the tab bar and around every round button. Android says "surface
 * resting on the page" with a fill, a radius and an elevation; that is what
 * it gets.
 */
const { parseColor } = require('./color');

/**
 * The real weight Apple gives a tint.
 *
 * Measured to the pixel on the same screens, iOS vs Android: a `GlassView`
 * tinted white at 0.4 leaves a light background... unchanged — 240,242,251
 * inside as outside. Apple does not PAINT the tint; it modulates its frosting
 * with it, and on light backgrounds almost nothing of it reaches the eye.
 * Painting the tint as declared on Android gave panels visibly milkier than
 * the same screens on iOS — THE visible difference between the two builds.
 * A quarter of the declared weight gets close to Apple's rendering while
 * keeping the surface visible at all.
 */
const TINT_WEIGHT = 0.25;

/**
 * The frosting of Apple's INTERACTIVE glass.
 *
 * Unlike a container, a button has matter: measured on a back button, iOS
 * renders it LIGHTER than the background (+7) where a container stays
 * neutral. The shadow a button declares shows through a translucent fill (on
 * both systems — CALayer and Android's boxShadow both draw it under the whole
 * surface), so the frosting must cover it too; hence this weight, calibrated
 * to the pixel against iOS.
 */
const INTERACTIVE_FROST = 0.4;

/** Style keys that draw a shadow, on either platform. */
const SHADOW_KEYS = ['boxShadow', 'shadowColor', 'shadowOpacity', 'shadowRadius', 'shadowOffset', 'elevation'];

/**
 * The tint a caller asked the glass for, at the weight Apple really gives it.
 *
 * Only a TRANSLUCENT tint is re-weighted. An opaque colour (`#3b6cf0`) is not
 * a glass tint, it is paint: the caller wants that colour, and quartering it
 * would turn a primary action into a pale ghost of itself.
 */
function tintAtAppleWeight(color, interactive) {
  const c = parseColor(color);
  if (!c || !(c.a < 1)) return color;
  const composed = interactive ? 1 - (1 - INTERACTIVE_FROST) * (1 - c.a) : c.a * TINT_WEIGHT;
  return `rgba(${c.r},${c.g},${c.b},${composed.toFixed(3)})`;
}

/**
 * The surface style off Apple's glass, with iOS's shadow rule applied.
 *
 * On iOS, CALayer computes a shadow from the view's ALPHA silhouette: an
 * almost transparent glass container casts practically nothing — a panel with
 * a declared shadow shows NO outline on iOS. Android's boxShadow always draws
 * the full rectangle: every container came out ringed by a ghost frame that
 * does not exist on iOS. So a container's shadow is removed; a button's —
 * whose frosting gives it a real fill — is kept, as iOS shows it.
 *
 * Takes an already-flattened style and returns a new object.
 */
function surfaceStyleOffApple(flatStyle, interactive) {
  const style = { ...(flatStyle || {}) };
  if (!interactive) for (const key of SHADOW_KEYS) delete style[key];
  return style;
}

/**
 * The default tint of an untinted glass button.
 *
 * On iOS 0.14 of white is enough: Apple's glass adds its own matter on top.
 * Off Apple's glass there is no such layer — at the same value the button
 * would vanish. It needs a real fill.
 */
function glassButtonTint({ mode, selected = false } = {}) {
  if (mode === 'native') return selected ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.14)';
  return selected ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.9)';
}

/**
 * The matter of a glass button: an object caught in an ice cube.
 *
 * The glass needs DEPTH — a highlight at the top, a denser foot — and what it
 * carries must come out sharp on top instead of being dimmed by a veil.
 *
 * Returns `{ glassStyle, highlight, glow }`, and deliberately nothing else:
 * no stroke. A white hairline at the top and an ink outline around read as
 * "lines that show it's plastic ice". On a real iPhone icon nothing rings the
 * glass — the light is INSIDE it.
 */
function glassButtonMaterial({ mode, scheme = 'light', tinted = false } = {}) {
  const dark = scheme === 'dark';
  /* `regular` frosts AND slightly darkens what it covers: on a white page it
     made the buttons grey and dull on a real iPhone. `clear` keeps the lens
     and its reflections without the veil. In dark mode the frosting is what
     separates the button from the night background. A tinted button carries
     its own colour: `clear` lets it through without washing it out. */
  const glassStyle = tinted || !dark ? 'clear' : 'regular';

  /* The top catches the light, the bottom thickens: this gradient is what
     reads as a domed volume rather than a flat disc. On a solid colour the
     highlight is stronger — it has to show on blue. */
  const highlight = tinted
    ? ['rgba(255,255,255,0.34)', 'rgba(255,255,255,0)', 'rgba(0,0,0,0.10)']
    : dark
      ? ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0)', 'rgba(0,0,0,0.22)']
      : ['rgba(255,255,255,0.70)', 'rgba(255,255,255,0)', 'rgba(13,18,53,0.05)'];

  /* The glow: iOS casts the shadow of a view WITHOUT a fill onto the
     silhouette of its content — the icon, the letters. A light halo around a
     dark icon lifts it off the glass; a dark shadow under a light icon (tinted
     button, dark mode) makes it pop. Android draws the whole rectangle
     instead: that would be a grey halo around every button. */
  const glow =
    mode !== 'native'
      ? null
      : tinted || dark
        ? {
            shadowColor: '#000000',
            shadowOpacity: dark && !tinted ? 0.45 : 0.28,
            shadowRadius: 2,
            shadowOffset: { width: 0, height: 1 }
          }
        : { shadowColor: '#ffffff', shadowOpacity: 0.95, shadowRadius: 2.5, shadowOffset: { width: 0, height: 0 } };

  return { glassStyle, highlight, glow };
}

module.exports = {
  TINT_WEIGHT,
  INTERACTIVE_FROST,
  SHADOW_KEYS,
  tintAtAppleWeight,
  surfaceStyleOffApple,
  glassButtonTint,
  glassButtonMaterial
};
