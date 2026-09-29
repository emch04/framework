const { chunkBlocks, chunkText, sentencesOf } = require('../src');
test('heading is kept with its paragraphs', () => {
  const result = chunkBlocks([{ kind: 'heading', text: 'Installation' }, { kind: 'paragraph', text: 'Connect the cable and check the indicator.' }], { minLength: 1 });
  expect(result[0].text).toContain('Installation\n');
  expect(result[0].text).toContain('Connect the cable');
});
test('new heading starts a new chunk', () => {
  const chunks = chunkText([{ kind: 'heading', text: 'First' }, { text: 'Alpha.' }, { kind: 'heading', text: 'Second' }, { text: 'Beta.' }]);
  expect(chunks).toEqual(['First\n\nAlpha.', 'Second\n\nBeta.']);
});
test('question stays with every paragraph it covers', () => {
  const chunks = chunkBlocks([{ kind: 'question', text: 'What changed?' }, { text: 'The first setting changed.', group: 'q' }, { text: 'The second setting changed.', group: 'q' }], { maxLength: 100, minLength: 1 });
  expect(chunks).toHaveLength(1);
  expect(chunks[0].text).toContain('What changed?\n\nThe first setting changed.\n\nThe second setting changed.');
});
test('together paragraphs appear once and keep their numbers', () => {
  const together = [{ number: 2, text: 'First point.' }, { number: 3, text: 'Second point.' }];
  const result = chunkBlocks([{ text: 'First point.', number: 2, together }, { text: 'Second point.', number: 3, together }], { minLength: 1 });
  expect(result).toHaveLength(1); expect(result[0].numbers).toEqual([2, 3]);
});
test('min size removes only short groups', () => {
  expect(chunkBlocks('Tiny.', { minLength: 10 })).toEqual([]);
  expect(chunkBlocks('A sufficiently descriptive paragraph.', { minLength: 10 })).toHaveLength(1);
});
test('long paragraph splits at sentences before splitting words', () => {
  const chunks = chunkText('First complete sentence. Second complete sentence. Third complete sentence.', { maxLength: 28, overlap: 0 });
  expect(chunks).toEqual(['First complete sentence.', 'Second complete sentence.', 'Third complete sentence.']);
});
test('exceptionally long words still fit the max', () => { expect(chunkText('x'.repeat(35), { maxLength: 12 }).every((s) => s.length <= 12)).toBe(true); });
test('overlap carries complete previous paragraph', () => {
  expect(chunkText('First.\n\nSecond.\n\nThird.', { maxLength: 16, overlap: 1 })).toEqual(['First.\n\nSecond.', 'Second.\n\nThird.']);
});
test('stable ids and hashes do not depend on unrelated document order', () => {
  const a = chunkBlocks('A descriptive paragraph.', { sourceId: 'doc', minLength: 1 });
  const b = chunkBlocks('A descriptive paragraph.', { sourceId: 'doc', minLength: 1 });
  expect(a[0].id).toBe(b[0].id); expect(a[0].contentHash).toBe(b[0].contentHash);
  expect(chunkBlocks('A descriptive paragraph.', { sourceId: 'other', minLength: 1 })[0].id).not.toBe(a[0].id);
});
test('sentence recognizer does not split an abbreviation followed by a digit', () => { expect(sentencesOf('See sec. 2 for details. Continue here.')).toEqual(['See sec. 2 for details.', 'Continue here.']); });
test('sentence recognizer keeps a French quotation and a scripture reference whole', () => { expect(sentencesOf('Lis Is. 66:13 ce soir. « Voici ce que dit Jéhovah. » Et ensuite ?')).toEqual(['Lis Is. 66:13 ce soir.', '« Voici ce que dit Jéhovah. »', 'Et ensuite ?']); });
