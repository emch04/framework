/**
 * The geometry of the floating tab bar, and the pagination pill that shares
 * its place — computed dry.
 *
 * The rendered bar (`TabBar`) is a thin shell over these numbers: which tab
 * sits in the middle, how wide a cell is, where the sliding pill must land.
 * Each of them was once wrong on a real phone; each is pinned by a test.
 */
const { floatingBottomOffset } = require('./collapse');

/** The bar's own height at scale 1, and the side margin to the screen edge. */
const TAB_BAR_HEIGHT = 62;
const TAB_BAR_SIDE_MARGIN = 26;
/* On a tablet a one-metre bar scatters five destinations to the four corners;
   it keeps a generous phone width and centres under the thumb. */
const TAB_BAR_MAX_WIDTH = 560;
/** Inner padding of the row: the pill never touches the bar's rounded ends. */
const TAB_ROW_MARGIN = 4;
/** Height of the active-tab pill at scale 1. */
const TAB_PILL_HEIGHT = 44;
/** Size of the raised centre button at scale 1. */
const TAB_CENTER_SIZE = 50;
/**
 * How long the destination waits after a tap, in ms.
 *
 * The page used to open in the same frame and cover the bar: the pill's slide
 * was never seen. It now waits until the pill has almost arrived.
 */
const TAB_OPEN_DELAY = 180;

/**
 * Puts the centre tab in the middle; the others keep their order around it.
 *
 * Returns `centerIndex: -1` when there is no centre tab — the bar is then a
 * plain row, same code, no raised button.
 */
function arrangeTabs(tabs, centerKey) {
  const list = Array.isArray(tabs) ? tabs : [];
  const center = centerKey == null ? undefined : list.find((tab) => tab.key === centerKey);
  if (!center) return { ordered: list, centerIndex: -1 };
  const rest = list.filter((tab) => tab !== center);
  const centerIndex = Math.floor(rest.length / 2);
  return { ordered: [...rest.slice(0, centerIndex), center, ...rest.slice(centerIndex)], centerIndex };
}

/** The width of one tab cell, once the row has been measured (0 before). */
function tabCellWidth(rowWidth, count, rowMargin = TAB_ROW_MARGIN) {
  if (!(rowWidth > 0) || !(count > 0)) return 0;
  return (rowWidth - rowMargin * 2) / count;
}

/**
 * Where the pill must land for `key`.
 *
 * An unknown key lands on the first cell rather than off the bar: a pill
 * sliding out of sight reads as a broken bar.
 */
function pillOffset(orderedKeys, key, cellWidth, rowMargin = TAB_ROW_MARGIN) {
  return rowMargin + Math.max(0, orderedKeys.indexOf(key)) * cellWidth;
}

/** The bar's width: the screen minus its margins, capped for tablets. */
function tabBarWidth(screenWidth, scale = 1, { sideMargin = TAB_BAR_SIDE_MARGIN, maxWidth = TAB_BAR_MAX_WIDTH } = {}) {
  return Math.min(screenWidth - sideMargin * 2, maxWidth * scale);
}

/** A badge never grows past three characters. */
function badgeText(count) {
  return count > 99 ? '99+' : String(count);
}

/** A screen reader hears the count, not just a red dot. */
function tabAccessibilityLabel(tab) {
  return tab.badge ? `${tab.label}, ${tab.badge}` : tab.label;
}

/** The pagination pill's height. */
const PAGINATION_HEIGHT = 52;

/**
 * The room to keep under a list so its last row can scroll ABOVE the pill,
 * instead of ending hidden behind it.
 */
function paginationReserve(bottomInset) {
  return floatingBottomOffset(bottomInset) + PAGINATION_HEIGHT + 16;
}

module.exports = {
  TAB_BAR_HEIGHT,
  TAB_BAR_SIDE_MARGIN,
  TAB_BAR_MAX_WIDTH,
  TAB_ROW_MARGIN,
  TAB_PILL_HEIGHT,
  TAB_CENTER_SIZE,
  TAB_OPEN_DELAY,
  arrangeTabs,
  tabCellWidth,
  pillOffset,
  tabBarWidth,
  badgeText,
  tabAccessibilityLabel,
  PAGINATION_HEIGHT,
  paginationReserve
};
