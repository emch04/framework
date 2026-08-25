const { createLanguageResolver } = require('../src');

const build = (overrides = {}) => createLanguageResolver({ languages: ['fr', 'en', 'es', 'ln'], ...overrides });

const withHeader = (value) => ({ headers: { 'accept-language': value } });

describe('language resolver', () => {
  test('reads the language the client asked for', () => {
    const resolver = build();

    expect(resolver.resolveLanguage(withHeader('en-GB,en;q=0.9'))).toBe('en');
    expect(resolver.resolveLanguage(withHeader('es'))).toBe('es');
    expect(resolver.resolveLanguage(withHeader('ln'))).toBe('ln');
  });

  test('a regional variant resolves to its language', () => {
    expect(build().resolveLanguage(withHeader('es-419,es-MX'))).toBe('es');
  });

  test('falls back when the header is absent, empty or malformed', () => {
    const resolver = build();

    expect(resolver.resolveLanguage({ headers: {} })).toBe('fr');
    expect(resolver.resolveLanguage(withHeader(''))).toBe('fr');
    expect(resolver.resolveLanguage(undefined)).toBe('fr');
    expect(resolver.resolveLanguage({})).toBe('fr');
  });

  test('a language we do not serve falls back rather than leaking through', () => {
    expect(build().resolveLanguage(withHeader('de-DE,de'))).toBe('fr');
  });

  test('the first language we DO serve wins, even behind one we do not', () => {
    expect(build().resolveLanguage(withHeader('de,es;q=0.8'))).toBe('es');
  });

  test('a stored preference wins over the browser header', () => {
    const resolver = build({ read: (req) => req.user?.language });

    expect(resolver.resolveLanguage({ user: { language: 'ln' }, headers: { 'accept-language': 'en' } })).toBe('ln');
  });

  test('a stored preference we do not serve falls back to the header', () => {
    const resolver = build({ read: () => 'de' });

    expect(resolver.resolveLanguage(withHeader('es'))).toBe('es');
  });

  test('always returns a language we serve — never null, never a raw tag', () => {
    const resolver = build();

    for (const header of ['', 'zz', '*', 'en;q=', ',,,', 'fr-CA']) {
      expect(resolver.languages).toContain(resolver.resolveLanguage(withHeader(header)));
    }
  });

  test('a source language outside the list is refused up front', () => {
    expect(() => build({ defaultLanguage: 'it' })).toThrow(/not in options.languages/);
  });
});
