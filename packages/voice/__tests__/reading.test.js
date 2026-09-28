const { createSpeechChunker, compareSpokenText, hasSpeechDrift, buildExpectedVocabulary } = require('../src');

test('chunker emits completed sentences across input chunks', () => {
  const chunker = createSpeechChunker();
  expect(chunker.push('Hello wor')).toEqual([]);
  expect(chunker.push('ld. Next')).toEqual(['Hello world.']);
  expect(chunker.flush()).toEqual(['Next']);
});
test('abbreviation catalog prevents false sentence split', () => {
  const chunker = createSpeechChunker({ abbreviations: ['dr'] });
  expect(chunker.push('Dr. Example arrived. Next')).toEqual(['Dr. Example arrived.']);
});
test('long sentence breaks at last comma after limit', () => {
  const chunker = createSpeechChunker({ maxLength: 12 });
  expect(chunker.push('alpha, beta, gamma delta')).toEqual(['alpha, beta,']);
});
test('flush clears remaining text once', () => {
  const chunker = createSpeechChunker(); chunker.push('last words');
  expect(chunker.flush()).toEqual(['last words']);
  expect(chunker.flush()).toEqual([]);
});
test('exact spoken text has full precision and coverage', () => {
  expect(compareSpokenText('one two three', 'one two three')).toEqual({ precision: 1, coverage: 1 });
});
test('added words lower precision and omitted words lower coverage', () => {
  expect(compareSpokenText('one two three', 'one extra two')).toEqual({ precision: 2 / 3, coverage: 2 / 3 });
});
test('number words are injected exclusions', () => {
  expect(compareSpokenText('chapter two begins', 'chapter begins', { ignoredWords: ['two'] })).toEqual({ precision: 1, coverage: 1 });
});
test('partial speech drift waits for enough words', () => {
  expect(hasSpeechDrift('alpha beta gamma delta', 'wrong', { final: false, minWords: 4 })).toBe(false);
  expect(hasSpeechDrift('alpha beta gamma delta', 'wrong words added here', { final: false, minWords: 4 })).toBe(true);
});
test('final speech drift includes missing coverage', () => {
  expect(hasSpeechDrift('alpha beta gamma delta', 'alpha beta', { final: true })).toBe(true);
});
test('expected vocabulary merges injected lists, deduplicates and limits size', () => {
  expect(buildExpectedVocabulary([['alpha', 'beta'], ['beta', 'gamma']], { maxChars: 10 })).toBe('alpha beta');
});
