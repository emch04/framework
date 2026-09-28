const { buildPassagesContext, isForeignLanguage, markForeignPassages, passageSource, primaryLanguage } = require('../src');

const texts = {
  header: '--- PASSAGES ---',
  footer: '--- END ---',
  foreign: 'A passage marked {languages} is in that language: translate what you use from it, and give its original reference.',
  empty: '--- NOTHING FOUND: cite no source. ---'
};

const french = { title: 'Étude 12, § 3', text: 'La patience se cultive.', lang: 'fr', ref: { study: 12, paragraph: 3 } };
const english = { title: 'Study 4', text: 'Patience grows.', lang: 'en' };

describe('language tags', () => {
  test('the primary subtag decides: fr-FR and fr are the same language', () => {
    expect(primaryLanguage('fr-FR')).toBe('fr');
    expect(primaryLanguage(' EN_gb ')).toBe('en');
    expect(primaryLanguage('')).toBeNull();
    expect(primaryLanguage(42)).toBeNull();
    expect(isForeignLanguage('fr-FR', 'fr')).toBe(false);
    expect(isForeignLanguage('fr', 'en')).toBe(true);
    expect(isForeignLanguage(undefined, 'en')).toBe(false);
  });
});

describe('markForeignPassages', () => {
  test('a passage in another language says so after its title; one in the reader\'s language does not', () => {
    const { blocks, languages } = markForeignPassages([french, english], { lang: 'en' });
    expect(blocks).toEqual(['Étude 12, § 3 [fr]\nLa patience se cultive.', 'Study 4\nPatience grows.']);
    expect(languages).toEqual(['fr']);
  });

  test('the tag format is the caller\'s', () => {
    const { blocks } = markForeignPassages([french], { lang: 'en', tag: (language) => `(${language.toUpperCase()})` });
    expect(blocks[0]).toBe('Étude 12, § 3 (FR)\nLa patience se cultive.');
  });

  test('empty passages are dropped; a passage without a title is its text', () => {
    const { blocks } = markForeignPassages([{ text: '' }, null, { text: 'Nu.' }], { lang: 'fr' });
    expect(blocks).toEqual(['Nu.']);
  });
});

describe('buildPassagesContext', () => {
  test('foreign passages bring the instruction to translate and keep the original reference', () => {
    const lines = buildPassagesContext({ passages: [french, english], lang: 'en', texts });
    expect(lines[0]).toBe(texts.header);
    expect(lines[lines.length - 2]).toBe(texts.footer);
    expect(lines[lines.length - 1]).toBe('A passage marked [fr] is in that language: translate what you use from it, and give its original reference.');
  });

  test('passages all in the reader\'s language: no instruction at all', () => {
    const lines = buildPassagesContext({ passages: [english], lang: 'en-US', texts });
    expect(lines).toEqual([texts.header, 'Study 4\nPatience grows.', texts.footer]);
  });

  test('several foreign languages are all named', () => {
    const lines = buildPassagesContext({ passages: [french, { title: 'T', text: 'x', lang: 'es' }], lang: 'en', texts });
    expect(lines[lines.length - 1]).toContain('[fr], [es]');
  });

  test('the search FAILED (null): nothing is said about the library — "nothing found" would be a lie', () => {
    expect(buildPassagesContext({ passages: null, lang: 'en', texts })).toEqual([]);
  });

  test('the search found nothing ([]): the caller\'s "nothing found" line', () => {
    expect(buildPassagesContext({ passages: [], lang: 'en', texts })).toEqual([texts.empty]);
  });

  test('a foreign passage without the instruction is refused rather than left for the model to guess', () => {
    expect(() => buildPassagesContext({ passages: [french], lang: 'en', texts: { header: 'x' } })).toThrow(/texts.foreign/);
  });
});

describe('passageSource', () => {
  test('keeps the original reference and cuts the excerpt', () => {
    const source = passageSource({ ...french, kind: 'study', text: 'a'.repeat(400) }, { excerptMax: 300 });
    expect(source.ref).toEqual({ study: 12, paragraph: 3 });
    expect(source.lang).toBe('fr');
    expect(source.excerpt).toHaveLength(300);
    expect(passageSource({ text: 'court' }).excerpt).toBe('court');
  });
});
