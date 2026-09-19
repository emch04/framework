/**
 * THE content card: flat, pale, in its own colour — and the tappable card,
 * glass on iOS, pale elsewhere.
 *
 * The colour maths and the reasons (no outline, no shadow, opaque fill) are
 * in logic/paleCard.js. The same rendering on iOS and Android, because there
 * is nothing either platform could composite differently: no shadow (it would
 * make the card "float", and Android draws it as a grey halo), no blur, no
 * glass.
 */
const { h, RN, LinearGradient, getGlassMode, useScheme } = require('./runtime');
const { GlassSurface } = require('./GlassSurface');
const { PALE_CARD_RADIUS, paleCardColors } = require('../logic/paleCard');
const { parseColor } = require('../logic/color');

const DEFAULT_PAGE = { light: '#ffffff', dark: '#000000' };
const DEFAULT_INK = { light: '#0d1235', dark: '#ffffff' };

/**
 * The card's colours for the current scheme — also for a pale background
 * that is not a card (a banner, a chip).
 */
function usePaleCardColors({ tint, pageBackground, ink, scheme: schemeOverride } = {}) {
  const scheme = useScheme(schemeOverride);
  return paleCardColors({
    scheme,
    pageBackground: pageBackground || DEFAULT_PAGE[scheme],
    ink: ink || DEFAULT_INK[scheme],
    tint
  });
}

function PaleCard({ children, tint, pageBackground, ink, scheme, style, ...rest }) {
  const { fill, top, bottom } = usePaleCardColors({ tint, pageBackground, ink, scheme });
  return h(
    RN.View,
    { ...rest, style: [{ borderRadius: PALE_CARD_RADIUS, overflow: 'hidden', backgroundColor: fill }, style] },
    top !== bottom
      ? h(LinearGradient, {
          pointerEvents: 'none',
          colors: [top, bottom],
          start: { x: 0, y: 0 },
          end: { x: 1, y: 1 },
          style: RN.StyleSheet.absoluteFill
        })
      : null,
    children
  );
}

/**
 * A card you TOUCH: a suggestion, a recipient in a list.
 *
 * Glass left the content of the screens for pale cards — then came back on
 * iOS, but only on what is touched. Never on a search bar, a field, or a card
 * that only shows. On iOS: Apple's glass, interactive (it reacts to the
 * finger), with no white tint added — only a trace of the accent. Elsewhere:
 * the pale card, unchanged; Android has no such material and its imitation
 * came out grey.
 *
 * The card does not handle the press itself: wrap it in (or put inside it)
 * the Pressable that fits the row.
 */
function TappableCard({ children, tint, pageBackground, ink, scheme, style }) {
  if (getGlassMode() === 'native') {
    const accent = tint && parseColor(tint);
    return h(
      GlassSurface,
      {
        interactive: true,
        glassStyle: 'regular',
        /* 8 % of the accent: a touch of colour in the glass, not a coat. */
        tintColor: accent ? `rgba(${accent.r},${accent.g},${accent.b},0.08)` : undefined,
        scheme,
        style: [{ borderRadius: PALE_CARD_RADIUS, overflow: 'hidden' }, style]
      },
      children
    );
  }
  return h(PaleCard, { tint, pageBackground, ink, scheme, style }, children);
}

module.exports = { PaleCard, TappableCard, usePaleCardColors };
