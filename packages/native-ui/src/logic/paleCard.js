/**
 * The colours of a pale card — its fill and its gradient — computed dry.
 *
 * WHY A PALE CARD AND NOT GLASS. Apple's glass on the CONTENT cards of a
 * screen was judged, on a real phone, plain ugly: reflections, blur, a
 * floating shadow. The rule that came out of it: glass stays on what floats
 * and what is tapped (buttons, bars); content gets flat pale cards, glued to
 * the page, in their own colour.
 *
 * WHY NO OUTLINE. At 7 % of tint the cards "had lost their colour" and it was
 * their hairline outline that delimited them — read as "lines that show it's
 * ice". No outline any more: the colour is INSIDE, in a light gradient
 * (lighter at the top, denser at the bottom, like the light inside an iPhone
 * icon), and that alone separates the card from the page.
 *
 * WHY OPAQUE. The fill is an opaque MIX of the tint over the page colour, not
 * an rgba: a page that paints a pattern under its content would show it
 * through a translucent card. The mix is done once, here, identical on iOS
 * and Android — no extra layer a platform could composite differently.
 */
const { parseColor, mixColors } = require('./color');

/** The card's corner radius. */
const PALE_CARD_RADIUS = 20;

/**
 * Proportion of tint mixed into the page, per scheme and variant.
 *
 * Each dose was chosen so the card shows on its page, yellow included. The
 * neutral light dose went from 4.5 % to 8 % after a settings screen became
 * "invisible" on an iPhone. On black the same proportion vanishes, so dark
 * doses go up; the dark neutral at 15 % comes out slightly lighter than
 * iOS's own card grey (#1c1c1e) — at 11 % it drowned in the black.
 */
const PALE_CARD_DOSAGE = Object.freeze({
  light: Object.freeze({
    tinted: Object.freeze({ top: 0.1, fill: 0.14, bottom: 0.2 }),
    neutral: Object.freeze({ top: 0.08, fill: 0.08, bottom: 0.08 })
  }),
  dark: Object.freeze({
    tinted: Object.freeze({ top: 0.16, fill: 0.22, bottom: 0.28 }),
    neutral: Object.freeze({ top: 0.15, fill: 0.15, bottom: 0.15 })
  })
});

/**
 * The colours of a pale card: its flat `fill` (for a pale background that is
 * not a card) and the two ends of its gradient (`top`, `bottom`).
 *
 * `tint` must already be the colour for the current scheme. A missing or
 * unreadable tint gives the NEUTRAL variant: `ink` — the theme's text colour
 * — heavily diluted. Page and ink are read from the caller's theme rather
 * than written here: when the dark theme moves, the card follows untouched.
 */
function paleCardColors({ scheme = 'light', pageBackground, ink, tint } = {}) {
  const readableTint = tint && parseColor(tint) ? tint : null;
  const dosage = PALE_CARD_DOSAGE[scheme === 'dark' ? 'dark' : 'light'][readableTint ? 'tinted' : 'neutral'];
  const colour = readableTint || ink;
  return {
    fill: mixColors(pageBackground, colour, dosage.fill),
    top: mixColors(pageBackground, colour, dosage.top),
    bottom: mixColors(pageBackground, colour, dosage.bottom)
  };
}

module.exports = { PALE_CARD_RADIUS, PALE_CARD_DOSAGE, paleCardColors };
