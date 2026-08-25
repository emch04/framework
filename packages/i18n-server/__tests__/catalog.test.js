const { createMessageCatalog } = require('../src');

const build = (overrides = {}) => createMessageCatalog({
  languages: ['fr', 'en', 'es'],
  messages: {
    'Cet élève est introuvable.': { en: 'This student could not be found.', es: 'No se encuentra a este alumno.' },
    'Connectez-vous pour continuer.': { en: 'Sign in to continue.' }
  },
  ...overrides
});

describe('message catalog', () => {
  test('translates what it knows', () => {
    const catalog = build();

    expect(catalog.translate('Cet élève est introuvable.', 'en')).toBe('This student could not be found.');
    expect(catalog.translate('Cet élève est introuvable.', 'es')).toBe('No se encuentra a este alumno.');
  });

  test('returns the source sentence in the source language', () => {
    expect(build().translate('Cet élève est introuvable.', 'fr')).toBe('Cet élève est introuvable.');
  });

  test('a sentence not yet in the catalogue stays readable, never blank, never a key', () => {
    /* This is what lets you adopt the package before the catalogue is full:
       the untranslated case is exactly today's behaviour. */
    const catalog = build();
    const unknown = 'Une phrase absente du catalogue.';

    for (const language of ['en', 'es', 'de']) {
      expect(catalog.translate(unknown, language)).toBe(unknown);
    }
  });

  test('a language declared but not filled in falls back, it does not blank out', () => {
    const catalog = build();

    expect(catalog.translate('Connectez-vous pour continuer.', 'es')).toBe('Connectez-vous pour continuer.');
  });

  test('a language we do not serve falls back to the source language', () => {
    expect(build().translate('Cet élève est introuvable.', 'de')).toBe('Cet élève est introuvable.');
  });

  test('empty and non-string values pass through untouched', () => {
    const catalog = build();

    expect(catalog.translate('', 'en')).toBe('');
    expect(catalog.translate(undefined, 'en')).toBeUndefined();
    expect(catalog.translate(null, 'en')).toBeNull();
    expect(catalog.translate(42, 'en')).toBe(42);
  });

  test('coverage counts what is done and names what is missing', () => {
    const report = build().coverage();

    expect(report.fr).toMatchObject({ translated: 2, total: 2, missing: [] });
    expect(report.en).toMatchObject({ translated: 2, total: 2, missing: [] });
    expect(report.es).toMatchObject({ translated: 1, total: 2 });
    expect(report.es.missing).toEqual(['Connectez-vous pour continuer.']);
  });

  test('the source language can be named explicitly', () => {
    const catalog = createMessageCatalog({
      languages: ['en', 'fr'],
      defaultLanguage: 'en',
      messages: { 'Not found.': { fr: 'Introuvable.' } }
    });

    expect(catalog.defaultLanguage).toBe('en');
    expect(catalog.translate('Not found.', 'fr')).toBe('Introuvable.');
    expect(catalog.translate('Not found.', 'en')).toBe('Not found.');
  });

  test('a translation for an undeclared language is a wiring mistake', () => {
    expect(() => build({ messages: { Bonjour: { de: 'Hallo' } } })).toThrow(/unknown language "de"/);
  });

  test('a source language outside the list is refused up front', () => {
    expect(() => build({ defaultLanguage: 'it' })).toThrow(/not in options.languages/);
  });

  test('a catalogue with no languages is refused up front', () => {
    expect(() => createMessageCatalog({})).toThrow(/languages/);
  });
});
