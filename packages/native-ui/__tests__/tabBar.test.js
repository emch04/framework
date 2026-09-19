const {
  PAGINATION_HEIGHT,
  TAB_BAR_MAX_WIDTH,
  TAB_ROW_MARGIN,
  arrangeTabs,
  badgeText,
  paginationReserve,
  pillOffset,
  tabAccessibilityLabel,
  tabBarWidth,
  tabCellWidth
} = require('../src/logic');

const tabs = ['home', 'people', 'ai', 'messages', 'more'].map((key) => ({ key, label: key }));

describe('arrangeTabs — the centre tab in the middle', () => {
  test('the centre tab moves to the middle, the others keep their order around it', () => {
    const shuffled = [tabs[2], tabs[0], tabs[1], tabs[3], tabs[4]];
    const { ordered, centerIndex } = arrangeTabs(shuffled, 'ai');
    expect(ordered.map((tab) => tab.key)).toEqual(['home', 'people', 'ai', 'messages', 'more']);
    expect(centerIndex).toBe(2);
  });

  test('with an odd number of side tabs, the extra one goes to the right', () => {
    expect(arrangeTabs(tabs.slice(0, 4), 'ai').ordered.map((t) => t.key)).toEqual(['home', 'ai', 'people', 'messages']);
  });

  test('without a centre tab the bar is a plain row, untouched', () => {
    expect(arrangeTabs(tabs, undefined)).toEqual({ ordered: tabs, centerIndex: -1 });
    expect(arrangeTabs(tabs, 'missing')).toEqual({ ordered: tabs, centerIndex: -1 });
    expect(arrangeTabs(undefined, 'ai')).toEqual({ ordered: [], centerIndex: -1 });
  });
});

describe('the sliding pill', () => {
  test('a cell is the measured row minus its margins, shared evenly', () => {
    expect(tabCellWidth(308, 5)).toBe((308 - TAB_ROW_MARGIN * 2) / 5);
    expect(tabCellWidth(0, 5)).toBe(0);
    expect(tabCellWidth(300, 0)).toBe(0);
  });

  test('the pill lands on the cell of the key', () => {
    const keys = tabs.map((tab) => tab.key);
    expect(pillOffset(keys, 'home', 60)).toBe(TAB_ROW_MARGIN);
    expect(pillOffset(keys, 'messages', 60)).toBe(TAB_ROW_MARGIN + 3 * 60);
  });

  test('an unknown key lands on the first cell, never off the bar', () => {
    expect(pillOffset(['a', 'b'], 'zzz', 60)).toBe(TAB_ROW_MARGIN);
  });
});

describe('bar size, badge, accessibility', () => {
  test('the bar fills a phone minus its margins, and is capped on a tablet', () => {
    expect(tabBarWidth(390)).toBe(390 - 52);
    expect(tabBarWidth(1024)).toBe(TAB_BAR_MAX_WIDTH);
    expect(tabBarWidth(1024, 1.12)).toBeCloseTo(TAB_BAR_MAX_WIDTH * 1.12);
  });

  test('a badge never grows past three characters', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });

  test('a screen reader hears the count', () => {
    expect(tabAccessibilityLabel({ label: 'Messages', badge: 3 })).toBe('Messages, 3');
    expect(tabAccessibilityLabel({ label: 'Home' })).toBe('Home');
  });
});

describe('paginationReserve', () => {
  test('the last row can scroll above the pill', () => {
    expect(paginationReserve(34)).toBe(42 + PAGINATION_HEIGHT + 16);
    expect(paginationReserve(0)).toBe(18 + PAGINATION_HEIGHT + 16);
  });
});
