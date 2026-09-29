const { cleanText, normalizeKind, normalizeImportance, mentionsName, patternRule, cosine, keywordScore, fuseByRank, buildPortrait } = require('../src');

test('cleanText removes model Markdown but keeps real words', () => {
  expect(cleanText('**Loves** `jazz`  and __rock__')).toBe('Loves jazz and rock');
  expect(cleanText('## Goal: learn C#')).toBe('Goal: learn C#');
  expect(cleanText('uses snake_case names')).toBe('uses snake_case names');
  expect(cleanText(42)).toBe('');
});

test('normalizeKind folds case and accents and reads aliases only into known kinds', () => {
  const kinds = ['goal', 'preference'];
  expect(normalizeKind(' GOAL ', { kinds })).toBe('goal');
  expect(normalizeKind('PRÉFÉRENCE', { kinds, aliases: { preference: 'preference' } })).toBe('preference');
  expect(normalizeKind('objectif', { kinds, aliases: { objectif: 'goal' } })).toBe('goal');
  expect(normalizeKind('ziel', { kinds, aliases: { ziel: 'dream' } })).toBeNull();
  expect(normalizeKind('', { kinds, fallback: 'goal' })).toBe('goal');
});

test('normalizeImportance clamps, rounds and falls back', () => {
  expect([normalizeImportance('4'), normalizeImportance(4.5), normalizeImportance(0), normalizeImportance(12), normalizeImportance('x', 2), normalizeImportance(null)])
    .toEqual([4, 5, 1, 5, 2, 3]);
  expect([normalizeImportance(''), normalizeImportance('   ', 2), normalizeImportance(' 4 ')]).toEqual([3, 2, 4]);
});

test('mentionsName matches whole words, folded, three letters or more', () => {
  expect(mentionsName('Suit JOSE ortega', 'José Ortega')).toBe(true);
  expect(mentionsName('Pauline arrive', 'Paul')).toBe(false);
  expect(mentionsName('Al is here', 'Al')).toBe(false);
});

test('patternRule needs a code and patterns; global regexes do not carry state between calls', () => {
  expect(() => patternRule({ patterns: [/x/] })).toThrow();
  expect(() => patternRule({ code: 'x', patterns: [] })).toThrow();
  const rule = patternRule({ code: 'secret', patterns: [/pin/g] });
  expect(rule({ text: 'my pin', role: 'a' })).toBe('secret');
  expect(rule({ text: 'my pin', role: 'a' })).toBe('secret');
});

test('ranking helpers', () => {
  expect(cosine([1, 0], [1, 0])).toBe(1);
  expect(cosine([0, 0], [1, 0])).toBe(0);
  expect(keywordScore('cartes visuelles', 'Préfère les CARTES')).toBe(0.5);
  expect(keywordScore('a b', 'a b')).toBe(0);
  expect(fuseByRank([['a', 'b'], ['b', 'c']])).toEqual(['b', 'a', 'c']);
  expect(buildPortrait([{ text: 'x', importance: 5 }, { text: 'y', importance: 3 }])).toBe('- x');
});

test('buildPortrait stops at the first memory that does not fit, or with fill leaves it out and keeps the shorter ones', () => {
  const memories = [
    { text: 'first', importance: 5, lastUsedAt: '2026-01-03' },
    { text: `long ${'x'.repeat(40)}`, importance: 5, lastUsedAt: '2026-01-02' },
    { text: 'short', importance: 4, lastUsedAt: '2026-01-01' }
  ];
  const plain = (memory) => memory.text;
  expect(buildPortrait(memories, { maxLength: 30, format: plain })).toBe('first');
  expect(buildPortrait(memories, { maxLength: 30, format: plain, fill: true })).toBe('first\nshort');
});
