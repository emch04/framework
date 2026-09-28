const { normalizeDocument, htmlBlocks, markdownBlocks, textBlocks, contentHash } = require('../src');
test('HTML headings and paragraphs become ordered blocks', () => {
  expect(htmlBlocks('<h2>Overview</h2><p data-pnum="3">Alpha <em>beta</em>.</p>')).toEqual([{ kind: 'heading', text: 'Overview' }, { kind: 'paragraph', text: 'Alpha beta.', number: 3 }]);
});
test('HTML noise and footnote-style aside are excluded', () => {
  expect(htmlBlocks('<script>secret</script><aside><p>duplicate</p></aside><p>Real text</p>')).toEqual([{ kind: 'paragraph', text: 'Real text' }]);
});
test('HTML entities and soft hyphens are cleaned', () => {
  expect(htmlBlocks('<p>A&nbsp;B &amp; C&#33; D\u00adE</p>')[0].text).toBe('A B & C! DE');
});
test('markdown headings, links and markup are cleaned', () => {
  expect(markdownBlocks('## Heading\n\nRead [guide](https://example.invalid) with **care**.')).toEqual([{ kind: 'heading', text: 'Heading' }, { kind: 'paragraph', text: 'Read guide with care.' }]);
});
test('markdown fenced code is excluded', () => { expect(markdownBlocks('First.\n\n```js\nsecret\n```\n\nLast.').map((b) => b.text)).toEqual(['First.', 'Last.']); });
test('plain text keeps paragraph seams', () => { expect(textBlocks('First line\nsecond line\n\nThird.').map((b) => b.text)).toEqual(['First line second line', 'Third.']); });
test('injected extractor overrides default cleanup', () => {
  expect(normalizeDocument({ id: 'x', content: 'raw', format: 'custom' }, { extractors: { custom: () => [{ kind: 'paragraph', text: 'custom output' }] } }).blocks[0].text).toBe('custom output');
});
test('unknown format and invalid blocks are rejected', () => {
  expect(() => normalizeDocument({ id: 'x', format: 'pdf' })).toThrow('EXTRACTOR_REQUIRED');
  expect(() => normalizeDocument({ id: 'x', format: 'text' }, { extractors: { text: () => [{ kind: 'bad', text: 'x' }] } })).toThrow('INVALID_BLOCKS');
});
test('content hash is deterministic and changes with content', () => { expect(contentHash('a')).toBe(contentHash('a')); expect(contentHash('a')).not.toBe(contentHash('b')); });
