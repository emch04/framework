/**
 * Apple's glass on iOS, a visible surface everywhere else.
 *
 * On iOS 26+ this is Apple's `GlassView`, as is. Elsewhere it is a plain View
 * whose fill is the caller's tint AT THE WEIGHT APPLE REALLY GIVES IT
 * (`tintAtAppleWeight`), with iOS's shadow rule applied
 * (`surfaceStyleOffApple`). Both rules, and the reason Android gets no blur,
 * are in logic/glass.js.
 */
const { h, RN, GlassEffect, getGlassMode, useScheme } = require('./runtime');
const { tintAtAppleWeight, surfaceStyleOffApple } = require('../logic/glass');

const base = { overflow: 'hidden' };

function GlassSurface({
  children,
  style,
  tintColor = 'rgba(255,255,255,0.12)',
  glassStyle = 'regular',
  interactive = false,
  scheme: schemeOverride,
  testID
}) {
  const scheme = useScheme(schemeOverride);
  if (getGlassMode() === 'native') {
    return h(
      GlassEffect.GlassView,
      {
        glassEffectStyle: glassStyle,
        tintColor,
        /* The APP's scheme, not the phone's: otherwise the glass stays light
           on a dark page and its content drowns. */
        colorScheme: scheme,
        isInteractive: interactive,
        style: [base, style],
        testID
      },
      children
    );
  }
  const flat = surfaceStyleOffApple(
    RN.StyleSheet.flatten([base, { backgroundColor: tintAtAppleWeight(tintColor, interactive) }, style]),
    interactive
  );
  return h(RN.View, { style: flat, testID }, children);
}

/**
 * A group of glass elements. On iOS, `GlassContainer` lets neighbouring
 * glass shapes merge and carries the spacing. Off iOS a bare View was
 * rendered and the elements ended up glued to each other: the spacing
 * becomes a `gap`.
 */
function GlassGroup({ children, spacing = 8, style, ...props }) {
  if (getGlassMode() === 'native') {
    return h(GlassEffect.GlassContainer, { spacing, style, ...props }, children);
  }
  return h(RN.View, { style: [{ gap: spacing }, style], ...props }, children);
}

module.exports = { GlassSurface, GlassGroup };
