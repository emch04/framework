const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMessageAudit, collectMessages, DEFAULT_JARGON } = require('../src');

describe('message audit', () => {
  const audit = createMessageAudit();

  test('accepts a sentence a customer can act on', () => {
    const findings = audit.inspect([{ message: 'This student could not be found.' }]);

    expect(findings.clean).toBe(true);
  });

  test('rejects developer words, and names which one', () => {
    const findings = audit.inspect([
      { file: 'auth.js', message: 'Invalid token, please retry.' },
      { file: 'sync.js', message: 'The payload could not be parsed properly.' }
    ]);

    expect(findings.clean).toBe(false);
    expect(findings.jargon).toHaveLength(2);
    expect(findings.jargon[0]).toMatchObject({ file: 'auth.js' });
    expect(findings.jargon[0].matched[0]).toMatch(/token/);
  });

  test('rejects a sentence that says too little', () => {
    const findings = audit.inspect([{ file: 'x.js', message: 'Not found' }]);

    expect(findings.tooShort).toHaveLength(1);
  });

  test('a message can be both too short and full of jargon', () => {
    const findings = audit.inspect([{ message: 'Invalid token' }]);

    expect(findings.jargon).toHaveLength(1);
    expect(findings.tooShort).toHaveLength(1);
  });

  test('the banned vocabulary is the product\'s to choose', () => {
    const custom = createMessageAudit({ jargon: [/\bwidget\b/i] });

    expect(custom.inspect([{ message: 'This token has expired for good.' }]).clean).toBe(true);
    expect(custom.inspect([{ message: 'The widget is unavailable now.' }]).clean).toBe(false);
  });

  test('the shortest acceptable sentence is configurable', () => {
    const strict = createMessageAudit({ minWords: 6, jargon: [] });

    expect(strict.inspect([{ message: 'This student could not be found.' }]).clean).toBe(true);
    expect(strict.inspect([{ message: 'This student was not found.' }]).clean).toBe(false);
  });

  test('an allow list exempts the rare case where the word IS the clearest one', () => {
    const lenient = createMessageAudit({ allow: ['Your token has expired. Sign in again.'] });

    expect(lenient.inspect([{ message: 'Your token has expired. Sign in again.' }]).clean).toBe(true);
  });

  test('describe() prints one readable line per finding', () => {
    const lines = audit.describe(audit.inspect([
      { file: 'auth.js', message: 'Invalid token here.' },
      { file: 'x.js', message: 'Nope' }
    ]));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('auth.js');
    expect(lines[1]).toContain('says too little');
  });

  test('an empty list is clean, not a crash', () => {
    expect(audit.inspect().clean).toBe(true);
    expect(audit.inspect([]).clean).toBe(true);
  });

  test('the default vocabulary catches the usual suspects', () => {
    for (const message of [
      'The token is invalid.', 'Bad payload received.', 'Value is null here.',
      'An exception occurred now.', 'The schoolId is missing.', 'Endpoint not reachable.'
    ]) {
      expect(audit.inspect([{ message }]).jargon).toHaveLength(1);
    }
    expect(DEFAULT_JARGON.length).toBeGreaterThan(5);
  });
});

describe('collecting messages from a source tree', () => {
  let root;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'astratra-audit-'));
    fs.mkdirSync(path.join(root, 'modules'));
    fs.writeFileSync(path.join(root, 'a.js'), 'apiResponse(res, 404, "This item could not be found.");');
    fs.writeFileSync(path.join(root, 'modules', 'b.js'), [
      'apiResponse(res, 400, "Invalid token here.");',
      'apiResponse(res, 200, "Saved successfully and safely.");',
      'apiResponse(res, 500, "Nope");'
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'notes.md'), 'apiResponse(res, 404, "ignored because not js");');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'c.js'), 'apiResponse(res, 404, "ignored dependency");');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const pattern = () => /apiResponse\(\s*res\s*,\s*[45]\d{2}\s*,\s*"([^"]+)"/g;

  test('walks the tree and finds the error messages', () => {
    const found = collectMessages({ root, pattern: pattern() });

    expect(found.map((f) => f.message).sort()).toEqual([
      'Invalid token here.', 'Nope', 'This item could not be found.'
    ]);
  });

  test('skips dependencies and non-source files', () => {
    const messages = collectMessages({ root, pattern: pattern() }).map((f) => f.message);

    expect(messages).not.toContain('ignored dependency');
    expect(messages).not.toContain('ignored because not js');
  });

  test('reports the file each message came from, relative to the root', () => {
    const found = collectMessages({ root, pattern: pattern() });
    const guilty = found.find((f) => f.message === 'Invalid token here.');

    expect(guilty.file).toBe(path.join('modules', 'b.js'));
  });

  test('scans EVERY file — a shared regex must not carry its position over', () => {
    /* A global regex keeps lastIndex between calls. Reusing one across files
       without resetting it silently skips half the tree. */
    const shared = pattern();
    const first = collectMessages({ root, pattern: shared });
    const second = collectMessages({ root, pattern: shared });

    expect(second).toEqual(first);
    expect(second).toHaveLength(3);
  });

  test('the collected messages feed straight into the audit', () => {
    const findings = createMessageAudit().inspect(collectMessages({ root, pattern: pattern() }));

    expect(findings.jargon).toHaveLength(1);
    expect(findings.tooShort).toHaveLength(1);
  });

  test('a non-global pattern is refused: it would match once per file', () => {
    expect(() => collectMessages({ root, pattern: /"([^"]+)"/ })).toThrow(/global RegExp/);
  });

  test('a missing root is refused up front', () => {
    expect(() => collectMessages({ pattern: pattern() })).toThrow(/root/);
  });
});
