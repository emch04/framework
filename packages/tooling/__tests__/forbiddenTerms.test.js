const {
  assertNoForbiddenTerms,
  findForbiddenTerms,
  findForbiddenTermsInFiles
} = require('../src/guards/forbiddenTerms');
const { createTempProject, writeFile } = require('./helpers');

describe('findForbiddenTerms', () => {
  test('a string term is a whole word, case-insensitive', () => {
    const report = findForbiddenTerms({ prompt: 'Built for ACME users.\nNot hardcoded.' }, ['acme', 'rdc']);
    expect(report.findings).toEqual([
      expect.objectContaining({ source: 'prompt', term: 'acme', match: 'ACME', line: 1 })
    ]);
  });

  test('word boundaries are Unicode-aware', () => {
    expect(findForbiddenTerms('Région', ['gion']).findings).toEqual([]);
    expect(findForbiddenTerms('la région nord', ['région']).findings).toHaveLength(1);
  });

  test('a negated mention is still a mention', () => {
    const report = findForbiddenTerms('This product is not only for Northland.', ['Northland']);
    expect(report.ok).toBe(false);
  });

  test('a multi-word term survives a line break', () => {
    expect(findForbiddenTerms('pay with mobile\n  wallet', ['mobile wallet']).findings).toHaveLength(1);
  });

  test('a RegExp term catches stems, and its reason travels with the finding', () => {
    const report = findForbiddenTerms(['north-only', 'Northern customers'], [{ pattern: /\bnorth/i, reason: 'the product is sold everywhere' }]);
    expect(report.findings.map((f) => [f.source, f.match, f.reason])).toEqual([
      ['text[0]', 'north', 'the product is sold everywhere'],
      ['text[1]', 'North', 'the product is sold everywhere']
    ]);
  });

  test('every occurrence is reported, with its line', () => {
    const report = findForbiddenTerms('acme\nok\nacme', ['acme']);
    expect(report.findings.map((f) => f.line)).toEqual([1, 3]);
  });

  test('allow keeps a legitimate line, and only that line', () => {
    const report = findForbiddenTerms('Powered by Acme Pay (trademark)\nFor Acme only', ['acme'], { allow: ['Acme Pay'] });
    expect(report.findings.map((f) => f.line)).toEqual([2]);
  });

  test('required terms must appear in every text', () => {
    const report = findForbiddenTerms({ a: 'A worldwide platform', b: 'A platform' }, [], { required: ['worldwide'] });
    expect(report.missing).toEqual([expect.objectContaining({ source: 'b', term: 'worldwide' })]);
    expect(report.ok).toBe(false);
  });

  test('refuses malformed terms', () => {
    expect(() => findForbiddenTerms('x', [''])).toThrow(/empty/);
    expect(() => findForbiddenTerms('x', [42])).toThrow(/terms\[0\]/);
  });

  test('assertNoForbiddenTerms throws with the excerpt, passes on clean text', () => {
    expect(() => assertNoForbiddenTerms({ email: 'Hello Acme' }, ['acme'])).toThrow('email:1 "Acme" (acme): Hello Acme');
    expect(assertNoForbiddenTerms({ email: 'Hello' }, ['acme']).ok).toBe(true);
  });
});

describe('findForbiddenTermsInFiles', () => {
  test('scans product files and skips tests, which quote forbidden words on purpose', () => {
    const rootDir = createTempProject();
    writeFile(rootDir, 'content/prompt.md', 'Serve Acme first.');
    writeFile(rootDir, 'content/locales/en.json', '{"hi": "Welcome"}');
    writeFile(rootDir, 'content/prompt.test.js', "expect(p).not.toMatch(/acme/i); // 'Acme'");
    writeFile(rootDir, 'content/__tests__/fixture.md', 'Acme');

    const report = findForbiddenTermsInFiles({ rootDir, dirs: ['content'], terms: ['acme'] });
    expect(report.fileCount).toBe(2);
    expect(report.findings).toEqual([expect.objectContaining({ source: 'content/prompt.md', line: 1 })]);
  });
});
