/**
 * The question at the top, the answer below — the way two people talk.
 *
 * When a message is sent to an assistant, the thread scrolls up to put the
 * question at the top of the screen, and the answer is written in all the
 * room left below. Before, the thread followed the bottom while the answer
 * streamed: every line received made the screen jump, and nothing could be
 * read calmly.
 *
 * For the question to be ABLE to reach the top even when the answer is short,
 * there must be room under it: a reserve, which shrinks as the answer grows.
 * Both computations live here, without React.
 */

/** The air left above the question once at the top, in points. */
const ANCHOR_MARGIN = 12;

/** Where to scroll to put the question at the top of the thread. */
function anchorOffset(anchorY) {
  return Math.max(0, anchorY - ANCHOR_MARGIN);
}

/**
 * The reserve to leave under the question so it can rise to the top.
 *
 * `contentHeight` is the height of the REAL content, reserve excluded — read
 * at the reserve's own position. The first version started from the total
 * scroll height, reserve included, minus the current reserve: but that
 * measure arrived one frame after the reserve it contained, so each new
 * reserve skewed the next one, and the question fell back to the middle of
 * the screen once the answer was done.
 *
 * With this, the maximum scroll is EXACTLY the question's position, whether
 * the answer grows or shrinks: nothing pushes it back down. As soon as the
 * answer fills the screen, the reserve drops to zero.
 */
function reserveBelowQuestion({ viewportHeight, contentHeight, anchorY }) {
  return Math.max(0, Math.round(viewportHeight - (contentHeight - anchorOffset(anchorY))));
}

module.exports = { ANCHOR_MARGIN, anchorOffset, reserveBelowQuestion };
