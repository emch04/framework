const { FOREGROUND_POLL_MS, freshItems, nextStamp, shouldPoll } = require('../src');

const item = (id, createdAt, read = false) => ({ id, createdAt, read });

describe('freshItems', () => {
  test('the first sweep raises nothing', () => {
    const items = [item('a', '2026-08-26T10:00:00.000Z'), item('b', '2026-08-26T11:00:00.000Z')];

    expect(freshItems(items, null)).toEqual([]);
  });

  test('only unread arrivals newer than the last sweep', () => {
    const items = [
      item('old', '2026-08-26T09:00:00.000Z'),
      item('new', '2026-08-26T11:00:00.000Z'),
      item('read-but-new', '2026-08-26T12:00:00.000Z', true)
    ];

    expect(freshItems(items, '2026-08-26T10:00:00.000Z').map((i) => i.id)).toEqual(['new']);
  });

  test('an item exactly at the mark was already seen', () => {
    const items = [item('a', '2026-08-26T10:00:00.000Z')];

    expect(freshItems(items, '2026-08-26T10:00:00.000Z')).toEqual([]);
  });

  test('unparsable dates are ignored, not treated as now', () => {
    expect(freshItems([item('a', 'yesterday')], '2026-08-26T10:00:00.000Z')).toEqual([]);
    expect(freshItems([item('a', '2026-08-26T11:00:00.000Z')], 'whenever')).toEqual([]);
  });

  test('junk in place of a list is answered with an empty list', () => {
    expect(freshItems(null, '2026-08-26T10:00:00.000Z')).toEqual([]);
  });
});

describe('nextStamp', () => {
  test('moves the mark to the latest arrival', () => {
    const items = [item('a', '2026-08-26T10:00:00.000Z'), item('b', '2026-08-26T12:00:00.000Z')];

    expect(nextStamp(items, '2026-08-26T09:00:00.000Z')).toBe('2026-08-26T12:00:00.000Z');
  });

  test('never moves backwards', () => {
    const items = [item('a', '2026-08-26T08:00:00.000Z')];

    expect(nextStamp(items, '2026-08-26T10:00:00.000Z')).toBe('2026-08-26T10:00:00.000Z');
  });

  test('nothing to read keeps the previous mark, null included', () => {
    expect(nextStamp([], '2026-08-26T10:00:00.000Z')).toBe('2026-08-26T10:00:00.000Z');
    expect(nextStamp([], null)).toBeNull();
  });

  test('a first sweep with items adopts their latest date', () => {
    expect(nextStamp([item('a', '2026-08-26T10:00:00.000Z')], null)).toBe('2026-08-26T10:00:00.000Z');
  });
});

describe('shouldPoll', () => {
  test('foreground with someone signed in, and nothing else', () => {
    expect(shouldPoll('active', true)).toBe(true);
    expect(shouldPoll('background', true)).toBe(false);
    expect(shouldPoll('inactive', true)).toBe(false);
    expect(shouldPoll('active', false)).toBe(false);
  });
});

test('the poll interval is exported so screens do not invent their own', () => {
  expect(FOREGROUND_POLL_MS).toBe(30_000);
});
