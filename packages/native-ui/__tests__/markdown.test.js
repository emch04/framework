const { inlinesToText, parseInline, parseMarkdown, splitTableRow } = require('../src/logic');

const text = (value) => [{ kind: 'text', text: value }];

describe('parseInline', () => {
  test('bold, italic, code and links become fragments', () => {
    expect(parseInline('the **bold** counts')).toEqual([
      { kind: 'text', text: 'the ' },
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' counts' }
    ]);
    expect(parseInline('a *light* accent')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'italic', text: 'light' },
      { kind: 'text', text: ' accent' }
    ]);
    expect(parseInline('call `send()` here')).toEqual([
      { kind: 'text', text: 'call ' },
      { kind: 'code', text: 'send()' },
      { kind: 'text', text: ' here' }
    ]);
    expect(parseInline('see [the report](https://example.test/r)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the report', href: 'https://example.test/r' }
    ]);
    expect(parseInline('__very__ sharp')).toEqual([
      { kind: 'bold', text: 'very' },
      { kind: 'text', text: ' sharp' }
    ]);
    expect(parseInline('[](https://example.test)')).toEqual([
      { kind: 'link', text: 'https://example.test', href: 'https://example.test' }
    ]);
  });

  test('AN UNCLOSED ** DOES NOT EAT THE END OF THE MESSAGE', () => {
    const [paragraph] = parseMarkdown('Careful **important and the rest stays readable');
    expect(paragraph.inlines).toEqual(text('Careful **important and the rest stays readable'));
  });

  test('a lone star, an identifier underscore and a lone backtick stay text', () => {
    expect(parseInline('3 * 4 = 12')).toEqual(text('3 * 4 = 12'));
    expect(parseInline('the field final_grade_2 is empty')).toEqual(text('the field final_grade_2 is empty'));
    expect(parseInline('a ` alone')).toEqual(text('a ` alone'));
    expect(parseInline('[link without target')).toEqual(text('[link without target'));
  });

  test('the stars leave the rendering but the text stays whole', () => {
    const [paragraph] = parseMarkdown('**Important**: the grade is *low*.');
    expect(inlinesToText(paragraph.inlines)).toBe('Important: the grade is low.');
  });
});

describe('parseMarkdown — blocks', () => {
  test('plain text comes out unchanged, as one paragraph', () => {
    expect(parseMarkdown('Hello, here is the class average.')).toEqual([
      { kind: 'paragraph', inlines: text('Hello, here is the class average.') }
    ]);
  });

  test('headings carry their level', () => {
    expect(parseMarkdown('## Results\n\n### Detail\n\ntext')).toEqual([
      { kind: 'heading', level: 2, inlines: text('Results') },
      { kind: 'heading', level: 3, inlines: text('Detail') },
      { kind: 'paragraph', inlines: text('text') }
    ]);
  });

  test('a bullet list and a numbered list each form one block', () => {
    expect(parseMarkdown('- one\n- two\n- three')).toEqual([
      {
        kind: 'bullets',
        items: [
          { depth: 0, inlines: text('one') },
          { depth: 0, inlines: text('two') },
          { depth: 0, inlines: text('three') }
        ]
      }
    ]);
    expect(parseMarkdown('1. first\n2. second')).toEqual([
      {
        kind: 'numbers',
        items: [
          { depth: 0, inlines: text('first') },
          { depth: 0, inlines: text('second') }
        ],
        start: 1
      }
    ]);
  });

  test('BULLETS UNDER EACH STEP DO NOT RESET THE NUMBERING TO 1', () => {
    const starts = (source) =>
      parseMarkdown(source)
        .filter((block) => block.kind === 'numbers')
        .map((block) => block.start);
    // The model writes "1." everywhere, or the real numbers: same rendering.
    expect(starts('1. Role\n- Director\n1. School\n- Name\n- Country\n1. Password')).toEqual([1, 2, 3]);
    expect(starts('1. Role\n\n- Director\n\n2. School\n\n- Name\n\n3. End')).toEqual([1, 2, 3]);
    // A multi-item step counts all its items.
    expect(starts('1. a\n2. b\n- note\n1. c')).toEqual([1, 3]);
    // A paragraph between two lists makes them two distinct lists.
    expect(starts('1. one\n2. two\n\nSomething else.\n\n1. again')).toEqual([1, 1]);
    // A written number other than 1 is authoritative.
    expect(starts('4. four\n5. five')).toEqual([4]);
  });

  test('a nested list keeps its levels without breaking the block', () => {
    const blocks = parseMarkdown('- maths\n  - algebra\n    - equations\n\t- tab\n- language');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].items.map((item) => [item.depth, inlinesToText(item.inlines)])).toEqual([
      [0, 'maths'],
      [1, 'algebra'],
      [2, 'equations'],
      [1, 'tab'],
      [0, 'language']
    ]);
  });

  test('a code block keeps its spaces and interprets nothing inside', () => {
    const blocks = parseMarkdown('Here:\n\n```js\nif (a) {\n    return **b**;\n}\n```\n\nEnd.');
    expect(blocks[1]).toEqual({ kind: 'code', language: 'js', text: 'if (a) {\n    return **b**;\n}' });
    expect(blocks[2]).toEqual({ kind: 'paragraph', inlines: text('End.') });
  });

  test('a missing closing fence ends the code block at the end of the message', () => {
    expect(parseMarkdown('```\nline\n- not a bullet')).toEqual([
      { kind: 'code', language: null, text: 'line\n- not a bullet' }
    ]);
  });

  test('a fence that names a language OPENS a block, it never closes one', () => {
    expect(parseMarkdown('```md\nExample:\n```js\nx\n```')).toEqual([
      { kind: 'code', language: 'md', text: 'Example:\n```js\nx' }
    ]);
  });

  test('a ~~~ fence is not closed by ```', () => {
    expect(parseMarkdown('~~~\na\n```\nb\n~~~')).toEqual([{ kind: 'code', language: null, text: 'a\n```\nb' }]);
  });

  test('tables keep their header, rows, and the text around them', () => {
    expect(parseMarkdown('Summary:\n\n| Name | Mark |\n| --- | --- |\n| Ada | 14 |\n| Alan | 17 |\n\nDone.')).toEqual([
      { kind: 'paragraph', inlines: text('Summary:') },
      { kind: 'table', header: ['Name', 'Mark'], rows: [['Ada', '14'], ['Alan', '17']] },
      { kind: 'paragraph', inlines: text('Done.') }
    ]);
  });

  test('a table without outer pipes is still a table', () => {
    expect(parseMarkdown('Class | Size\n:--- | ---:\n6A | 32')).toEqual([
      { kind: 'table', header: ['Class', 'Size'], rows: [['6A', '32']] }
    ]);
  });

  test('a quote forms its own block', () => {
    expect(parseMarkdown('> a remark\n> on two lines')).toEqual([
      { kind: 'quote', inlines: text('a remark\non two lines') }
    ]);
  });

  test('empty or missing input gives no block', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
    expect(parseMarkdown(undefined)).toEqual([]);
  });

  test('a complete answer is cut in display order, CRLF included', () => {
    const blocks = parseMarkdown(
      '## Summary\r\n\r\nHere is the **gist**.\r\n\r\n- a point\r\n- two points\r\n\r\n```py\r\nprint(1)\r\n```\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n'
    );
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'bullets', 'code', 'table']);
  });

  test('NO RULE BETWEEN PARAGRAPHS: ---, *** and ___ are dropped', () => {
    for (const rule of ['---', '***', '___', ' - - - ', '-----']) {
      expect(parseMarkdown(`First.\n\n${rule}\n\nSecond.`).map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
    }
    // A rule glued to text still separates two paragraphs.
    expect(parseMarkdown('First.\n---\nSecond.').map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
    // A table and a list are not rules.
    expect(parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')[0].kind).toBe('table');
    expect(parseMarkdown('- one\n- two')[0].kind).toBe('bullets');
  });
});

describe('splitTableRow', () => {
  test('outer pipes are optional, cells are trimmed', () => {
    expect(splitTableRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitTableRow('a|b')).toEqual(['a', 'b']);
  });
});
