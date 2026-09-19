/**
 * The collapsible page header, in numbers.
 *
 * Scrolling down a page used to take everything away — the title, the back
 * button — and the reader no longer knew where they were. The rule now:
 *
 *  - the back button and the action buttons stay FIXED, always there;
 *  - the large title scrolls away with the page;
 *  - once it has gone, a small bar fades in at the top: the content slides
 *    under it, blurred, and the page name is written in its centre.
 *
 * Under the bar, a FADE and not a line: the bar's background overflows by a
 * few points and dies out there, so content disappears under it instead of
 * being cut clean — a straight edge read as a rule drawn across the screen.
 */
const { parseColor } = require('./color');

/** The bar's height, below the status bar. */
const HEADER_BAR_HEIGHT = 52;
/** The fade-in happens over these points of scroll, just before the threshold. */
const HEADER_FADE_RUN = 28;
/**
 * Length of the fade under the bar, per platform.
 *
 * Android is shorter and lighter: without a blur, a solid band under the
 * title "weighed too much". Its background lets the content show (94 % then
 * 80 % at the bar's bottom edge) and dies out over a shorter band.
 */
const HEADER_BOTTOM_FADE = Object.freeze({ ios: 26, android: 16 });
/** Before the title has been measured, the bar appears after this offset. */
const HEADER_DEFAULT_THRESHOLD = 72;

/**
 * The scroll offset at which the bar has fully appeared: when the bottom of
 * the large title passes under the bar. The content starts BELOW the bar, so
 * the bar's own height comes off — and the status-bar inset too, when the
 * scrolling content carries it as padding instead of a safe-area view. Never
 * below 40: a page with a tiny title would otherwise show the bar at the
 * first pixel of scroll.
 *
 * @param {number} titleBottom  Bottom of the title, in content coordinates.
 * @param {number} [topInset]   Inset padded INSIDE the scroll content, if any.
 */
function headerThreshold(titleBottom, topInset = 0) {
  return Math.max(40, titleBottom - HEADER_BAR_HEIGHT - topInset);
}

/*
 * The two fade functions carry the 'worklet' directive: the header's animated
 * styles call them on the UI thread, where only worklets can run. In Node the
 * directive is an inert string.
 */

/** Input/output ranges for the bar's opacity. */
function headerBarFade(threshold) {
  'worklet';
  return { input: [threshold - HEADER_FADE_RUN, threshold], output: [0, 1] };
}

/**
 * Input ranges for the small title: it starts later than the bar and rises
 * 6 points as it appears, so it lands rather than blinks.
 */
function headerTitleFade(threshold) {
  'worklet';
  return {
    opacity: { input: [threshold - HEADER_FADE_RUN / 2, threshold + 8], output: [0, 1] },
    translateY: { input: [threshold - HEADER_FADE_RUN, threshold + 8], output: [6, 0] }
  };
}

function headerBottomFade(platform) {
  return platform === 'android' ? HEADER_BOTTOM_FADE.android : HEADER_BOTTOM_FADE.ios;
}

/** Gradient stops: solid down to the bar's bottom edge, then dying out in the overflow. */
function headerGradientStops(barHeight, fadeLength) {
  return [0, barHeight / (barHeight + fadeLength), 1];
}

/**
 * Android's background: the page colour, fading the same way. Its blur came
 * out "dirty"; a clean gradient stays clean. Accepts any colour notation —
 * appending hex alpha digits to a colour only works if it was `#rrggbb`.
 */
function androidHeaderColors(pageBackground) {
  const c = parseColor(pageBackground) || { r: 255, g: 255, b: 255 };
  const rgba = (a) => `rgba(${c.r},${c.g},${c.b},${a})`;
  return [rgba(0.94), rgba(0.8), rgba(0)];
}

module.exports = {
  HEADER_BAR_HEIGHT,
  HEADER_FADE_RUN,
  HEADER_BOTTOM_FADE,
  HEADER_DEFAULT_THRESHOLD,
  headerThreshold,
  headerBarFade,
  headerTitleFade,
  headerBottomFade,
  headerGradientStops,
  androidHeaderColors
};
