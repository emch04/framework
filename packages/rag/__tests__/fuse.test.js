const { fuseByRank } = require('../src');
test('agreement across lists lifts a result', () => { expect(fuseByRank([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }]])[0].id).toBe('b'); });
test('weights change ranking', () => { expect(fuseByRank([[{ id: 'a' }], [{ id: 'b' }]], 60, [1, 3])[0].id).toBe('b'); });
test('duplicate inside one list counts once', () => { const result = fuseByRank([[{ id: 'a' }, { id: 'a' }], [{ id: 'b' }]]); expect(result.find((x) => x.id === 'a').score).toBeCloseTo(1 / 61); });
test('first copy of an item supplies its metadata', () => { expect(fuseByRank([[{ id: 'a', title: 'first' }], [{ id: 'a', title: 'second' }]])[0].title).toBe('first'); });
test('zero weight disables a list', () => { expect(fuseByRank([[{ id: 'a' }], [{ id: 'b' }]], 60, [0, 1])[0].id).toBe('b'); });
test('invalid k and weights are rejected', () => { expect(() => fuseByRank([], 0)).toThrow('INVALID_RRF'); expect(() => fuseByRank([[{ id: 'a' }]], 60, [-1])).toThrow('INVALID_RRF_WEIGHT'); });
