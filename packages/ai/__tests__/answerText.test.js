const { isFaithfulQuotation, plainText, tidyMarkdown, verifyQuotations } = require('../src');

describe('tidyMarkdown', () => {
  test('brings headings, bullets and bold back to what a phone draws', () => {
    expect(tidyMarkdown('# Titre\n* un\n• deux\n__gras__')).toBe('### Titre\n- un\n- deux\n**gras**');
  });

  test('italics, code, links and rules lose their marks; the words stay', () => {
    expect(tidyMarkdown('Un *mot* en `code` et [un lien](https://x.test)\n\n---\n\nSuite')).toBe('Un mot en code et un lien\n\nSuite');
  });

  test('a table becomes readable rows', () => {
    expect(tidyMarkdown('| Élève | Note |\n|---|---|\n| Kevin | 14 |')).toBe('Élève · Note\nKevin · 14');
  });

  test('emoji go only when asked', () => {
    expect(tidyMarkdown('Bravo 🎉')).toBe('Bravo 🎉');
    expect(tidyMarkdown('Bravo 🎉', { removeEmoji: true })).toBe('Bravo');
  });

  test('extra blank lines and trailing spaces are removed', () => {
    expect(tidyMarkdown('a   \n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('plainText', () => {
  test('what a voice reads: no symbol left', () => {
    expect(plainText('### Titre\n> citation\n- **gras** et *italique*')).toBe('Titre\ncitation\ngras et italique');
    expect(plainText(null)).toBe('');
  });
});

describe('verifyQuotations', () => {
  const truth = { 'Loi 12': 'Tout élève a droit à une éducation gratuite et de qualité.' };
  const findReferences = (text) => [...text.matchAll(/Loi \d+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length, refs: m[0] }));
  const resolve = async (refs) => truth[refs] || null;

  test('an unfaithful quotation followed by its reference is replaced by the true text', async () => {
    const out = await verifyQuotations('La loi dit « Tout élève a droit à l\'école » (Loi 12).', { findReferences, resolve });
    expect(out).toBe('La loi dit « Tout élève a droit à une éducation gratuite et de qualité. » (Loi 12).');
  });

  test('a faithful quotation, even cut by an ellipsis, is left alone', async () => {
    const text = 'Elle dit “Tout élève a droit … de qualité” Loi 12';
    expect(await verifyQuotations(text, { findReferences, resolve })).toBe(text);
    expect(isFaithfulQuotation('TOUT ÉLÈVE, a droit', truth['Loi 12'])).toBe(true);
  });

  test('a quotation without a reference right after it is not touched', async () => {
    const text = 'Il a dit "rien du tout" hier, puis la Loi 12 a été votée.';
    expect(await verifyQuotations(text, { findReferences, resolve })).toBe(text);
  });

  test('an unknown reference, or a reader that fails, leaves the text as written', async () => {
    const text = '« inventé » (Loi 99)';
    expect(await verifyQuotations(text, { findReferences, resolve })).toBe(text);
    expect(await verifyQuotations(text, { findReferences: () => { throw new Error('down'); }, resolve })).toBe(text);
  });

  test('several quotations are each judged on their own', async () => {
    const out = await verifyQuotations('« faux » (Loi 12) et « Tout élève a droit » (Loi 12)', { findReferences, resolve });
    expect(out).toBe(`« ${truth['Loi 12']} » (Loi 12) et « Tout élève a droit » (Loi 12)`);
  });

  test('both readers are required', async () => {
    await expect(verifyQuotations('x', {})).rejects.toThrow(/findReferences/);
  });
});
