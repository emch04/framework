const { readResourceItems, readResourceTitle, readResourceSubtitle } = require('../src');

describe('readResourceItems', () => {
  test('a bare array is the list', () => {
    expect(readResourceItems([{ id: 'a' }, { id: 'b' }])).toHaveLength(2);
  });

  test('a wrapped list is found whatever the wrapper calls it', () => {
    expect(readResourceItems({ orders: [{ id: 'a' }], total: 1 })).toEqual([{ id: 'a' }]);
    expect(readResourceItems({ data: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
  });

  test('a single object is a list of one — a detail endpoint still renders', () => {
    expect(readResourceItems({ id: 'a', name: 'Solo' })).toEqual([{ id: 'a', name: 'Solo' }]);
  });

  test('junk yields an empty list rather than a crash', () => {
    expect(readResourceItems(null)).toEqual([]);
    expect(readResourceItems('nope')).toEqual([]);
    expect(readResourceItems(undefined)).toEqual([]);
  });

  test('non-objects inside a list are dropped', () => {
    expect(readResourceItems([{ id: 'a' }, null, 'x', 3])).toEqual([{ id: 'a' }]);
  });
});

describe('readResourceTitle', () => {
  test('takes the first field that actually says who this is', () => {
    expect(readResourceTitle({ email: 'a@b.c', fullName: 'Jean Dupont' })).toBe('Jean Dupont');
    expect(readResourceTitle({ email: 'a@b.c' })).toBe('a@b.c');
  });

  test('a number is a usable name; blank strings are not', () => {
    expect(readResourceTitle({ name: '   ', id: 42 })).toBe('42');
    expect(readResourceTitle({})).toBe('');
  });

  test('the fields to try can be replaced for another domain', () => {
    expect(readResourceTitle({ reference: 'INV-1' }, ['reference'])).toBe('INV-1');
  });
});

describe('readResourceSubtitle', () => {
  test('answers with the first useful detail, and nothing when there is none', () => {
    expect(readResourceSubtitle({ status: 'paid', email: 'a@b.c' })).toBe('a@b.c');
    expect(readResourceSubtitle({ status: 'paid' })).toBe('paid');
    expect(readResourceSubtitle({})).toBe('');
  });
});
