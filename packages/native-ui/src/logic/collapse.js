/**
 * When a floating bar folds away and when it comes back — the Instagram rule.
 *
 * Scroll down into the page, the bar shrinks; scroll back up, it returns to
 * full size. The decision lives here, without React, to be tested alone; the
 * `useCollapsingBar` hook only feeds it scroll offsets.
 *
 * Two guards. A finger tremor (less than COLLAPSE_THRESHOLD points) changes
 * nothing. And at the very top of the page the bar is always full: iOS's
 * rubber-band bounce at the top must not fold it.
 */

/** Minimal travel, in points, for a direction to count. */
const COLLAPSE_THRESHOLD = 8;
/** Below this scroll offset the bar stays full. */
const TOP_ZONE = 24;

/**
 * One step of the decision.
 *
 * `anchor` is where the direction was last decided: the offset is compared to
 * IT, not to the previous frame, so that a slow scroll (one point per frame)
 * still ends up counting. Comparing frame to frame, a slow reader could scroll
 * a whole page without the bar ever moving.
 *
 * @param {{collapsed: boolean, anchor: number}} state
 * @param {number} y  The scroll offset.
 */
function followScroll(state, y) {
  if (y <= TOP_ZONE) return { collapsed: false, anchor: Math.max(0, y) };
  const travel = y - state.anchor;
  if (travel > COLLAPSE_THRESHOLD) return { collapsed: true, anchor: y };
  if (travel < -COLLAPSE_THRESHOLD) return { collapsed: false, anchor: y };
  return state;
}

/** The state a screen starts in. */
const INITIAL_COLLAPSE = Object.freeze({ collapsed: false, anchor: 0 });

/* ── Bar size ─────────────────────────────────────────────────────────────
   Tuned on a standard iPhone (390 points wide). On a large phone the bar
   looked tiny: it grows with the screen width — height, icons, labels,
   together, not in length — up to 12 % more. Never smaller. */
const REFERENCE_WIDTH = 390;
const MAX_BAR_SCALE = 1.12;

function barScale(screenWidth) {
  const width = Number(screenWidth);
  if (!Number.isFinite(width)) return 1;
  return Math.min(MAX_BAR_SCALE, Math.max(1, width / REFERENCE_WIDTH));
}

/* Folded, a bar shrinks toward the bottom to 84 % and drops 6 points: its
   labels fade, its icons stay — it can still be tapped. */
const COLLAPSED_SCALE = 0.84;
const COLLAPSED_DROP = 6;

/**
 * Where a floating bottom element sits: above the gesture bar / home
 * indicator, never glued to the bottom edge.
 */
function floatingBottomOffset(bottomInset) {
  return Math.max(18, (Number(bottomInset) || 0) + 8);
}

module.exports = {
  COLLAPSE_THRESHOLD,
  TOP_ZONE,
  INITIAL_COLLAPSE,
  followScroll,
  REFERENCE_WIDTH,
  MAX_BAR_SCALE,
  barScale,
  COLLAPSED_SCALE,
  COLLAPSED_DROP,
  floatingBottomOffset
};
