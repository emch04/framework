const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { findDuplicateKeys, findHardcodedSubjects, scanSourceTree } = require('../src');

describe('duplicate keys in a catalogue literal', () => {
  test('a key written twice is found, with both lines — the first value was silently lost', () => {
    const source = [
      'const CATALOG = {',
      '  "This account could not be found.": ["Cuenta no encontrada.", "A1"],',
      '  "Sign in to continue.": ["Inicie sesión.", "A2"],',
      '  "This account could not be found.": ["Esta cuenta no existe.", "B1"],',
      '};'
    ].join('\n');

    const { keys, duplicates } = findDuplicateKeys(source, { start: 'const CATALOG = {' });

    expect(duplicates).toEqual([{ key: 'This account could not be found.', lines: [2, 4] }]);
    expect(keys).toHaveLength(3);
  });

  test('the loaded object proves it: one key fewer than the source holds', () => {
    /* Why the audit reads SOURCE: once evaluated, the first value is gone. */
    const literal = '({ "a": 1, "b": 2, "a": 3 })';
    const loaded = vm.runInNewContext(literal);

    expect(Object.keys(loaded)).toHaveLength(2);
    expect(loaded.a).toBe(3);
    expect(findDuplicateKeys(literal).keys).toHaveLength(3);
  });

  test('a clean catalogue reports every key and no duplicate', () => {
    const source = 'module.exports = { "a.title": { en: "A" }, "b.title": { en: "B" }, plain: 1 };';
    const { keys, duplicates } = findDuplicateKeys(source);

    expect(keys.map((k) => k.key)).toEqual(['a.title', 'b.title', 'plain']);
    expect(duplicates).toEqual([]);
  });

  test('nested keys are not top-level keys — every entry has its own "en"', () => {
    const source = `const DICT = {
      "hello": { fr: "Bonjour", en: "Hello" },
      "bye":   { fr: "Au revoir", en: "Bye" },
    };`;

    expect(findDuplicateKeys(source).duplicates).toEqual([]);
  });

  test('braces, commas and quotes inside strings, templates and comments are not structure', () => {
    const source = `const M = {
      // "commented": { a: 1 }, "x": 1,
      /* "block": "}", */
      "a": "text with } and , and { inside",
      'b': 'it\\'s fine, really',
      c: (p) => \`\${p.name}, {braces} \${p.more ? "}" : "{"}\`,
      "d": [1, { e: 2 }, "]"],
      "a": "the duplicate after all that noise",
    };`;

    const { keys, duplicates } = findDuplicateKeys(source);

    expect(keys.map((k) => k.key)).toEqual(['a', 'b', 'c', 'd', 'a']);
    expect(duplicates).toEqual([{ key: 'a', lines: [4, 8] }]);
  });

  test('escaped quotes in a key are unescaped, so "a\\"b" and a"b are the same key', () => {
    const source = String.raw`({ "say \"hi\"": 1, 'say "hi"': 2 })`;

    expect(findDuplicateKeys(source).duplicates).toEqual([{ key: 'say "hi"', lines: [1, 1] }]);
  });

  test('the start can be a RegExp, and code before it is ignored', () => {
    const source = 'const OTHER = { a: 1, a: 2 };\nconst DICT = { a: 1, b: 2 };';

    expect(findDuplicateKeys(source, { start: /const DICT\s*=/ }).duplicates).toEqual([]);
    expect(findDuplicateKeys(source).duplicates).toHaveLength(1);
  });

  test('spread and shorthand entries are skipped, not mistaken for keys', () => {
    const source = 'const M = { ...base, shorthand, "a": 1, [computed]: 2, method() { return { a: 1 }; } };';

    expect(findDuplicateKeys(source).keys.map((k) => k.key)).toEqual(['a']);
  });

  test('a start that is not in the file is refused, not reported clean', () => {
    expect(() => findDuplicateKeys('const A = {};', { start: 'const CATALOG' })).toThrow(/no object literal/);
  });
});

describe('hardcoded mail subjects', () => {
  const scan = (source, options = {}) => findHardcodedSubjects(source, { callee: 'sendEmail', argument: 1, ...options });

  test('the detector sees a subject written in the call', () => {
    expect(scan('sendEmail(user.email, "Your account has changed", text, html)')).toHaveLength(1);
    expect(scan("sendEmail(user.email, 'Votre compte a changé', text)")).toHaveLength(1);
    expect(scan('sendEmail(user.email, `Welcome, ${user.name}`, text)')).toHaveLength(1);
  });

  test('a subject from the catalogue, a variable or a composed value passes', () => {
    expect(scan('sendEmail(user.email, tr("reset.subject"), text, html)')).toEqual([]);
    expect(scan('sendEmail(person.email, SUBJECT, MESSAGE)')).toEqual([]);
    expect(scan('sendEmail(person.email, `${prefix}${subject}`, body)')).toEqual([]);
    expect(scan('sendEmail(person.email, "Re: " + subject, body)')).toEqual([]);
  });

  test('the first argument is skipped properly, nested parentheses and commas included', () => {
    expect(scan('sendEmail(pick(a, b).email, "Hello there", t)')).toHaveLength(1);
    expect(scan('sendEmail([a, b].join(","), tr("x"), "Body text is fine")')).toEqual([]);
  });

  test('calls inside comments and strings are not calls', () => {
    const source = [
      '// sendEmail(user.email, "Your account has changed")',
      '/* sendEmail(x, "Nope") */',
      'const doc = "sendEmail(x, \\"Nope\\")";'
    ].join('\n');

    expect(scan(source)).toEqual([]);
  });

  test('the report says where', () => {
    const source = 'function a() {}\n\nsendEmail(\n  user.email,\n  "Your password was changed",\n  text\n);';
    const [finding] = scan(source);

    expect(finding).toMatchObject({ line: 5, callee: 'sendEmail' });
    expect(finding.literal).toBe('"Your password was changed"');
  });

  test('an object-shaped call is read through its property', () => {
    const options = { callee: 'mailer.send', argument: 0, property: 'subject' };

    expect(findHardcodedSubjects('mailer.send({ to, subject: "Order confirmed", text })', options)).toHaveLength(1);
    expect(findHardcodedSubjects('mailer.send({ to, subject: tr("order.subject"), text: "Body" })', options)).toEqual([]);
    expect(findHardcodedSubjects('mailer.send(message)', options)).toEqual([]);
  });

  test('the test can be narrowed to one language', () => {
    const french = /[À-ÿ]|\b(votre|vous|compte)\b/i;

    expect(scan('sendEmail(TEAM, "[Monitoring] disk full", t)', { test: french })).toEqual([]);
    expect(scan('sendEmail(user.email, "Votre compte", t)', { test: french })).toHaveLength(1);
    expect(scan('sendEmail(user.email, "Votre compte", t)', { test: (text) => text.startsWith('Votre') })).toHaveLength(1);
  });

  test('a call to a fixed internal address can be exempted', () => {
    const source = 'sendEmail(process.env.TEAM_EMAIL, "Disk almost full", t);\nsendEmail(user.email, "Welcome aboard", t);';

    expect(scan(source, { ignore: [/TEAM_EMAIL/] })).toHaveLength(1);
  });

  test('placeholders alone are not written text', () => {
    expect(scan('sendEmail(user.email, `${subject}`, t)')).toEqual([]);
  });

  test('a callee is required', () => {
    expect(() => findHardcodedSubjects('x')).toThrow(/callee/);
  });
});

describe('scanning a source tree', () => {
  let root;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'astratra-scan-'));
    fs.mkdirSync(path.join(root, 'auth'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'auth', 'reset.js'), 'sendEmail(user.email, "Reset your password", t);');
    fs.writeFileSync(path.join(root, 'auth', 'ok.js'), 'sendEmail(user.email, tr("reset.subject"), t);');
    fs.writeFileSync(path.join(root, 'auth', 'monitor.js'), 'sendEmail(user.email, "Internal alert", t);');
    fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'sendEmail(x, "Dependency", t);');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const inspect = (source) => findHardcodedSubjects(source, { callee: 'sendEmail', argument: 1 });

  test('findings carry the file they came from, dependencies are skipped', () => {
    const findings = scanSourceTree({ root, inspect });

    expect(findings.map((f) => f.file).sort()).toEqual([path.join('auth', 'monitor.js'), path.join('auth', 'reset.js')]);
  });

  test('a single file can be exempted by its relative path', () => {
    const findings = scanSourceTree({ root, inspect, ignore: ['node_modules', path.join('auth', 'monitor.js')] });

    expect(findings.map((f) => f.file)).toEqual([path.join('auth', 'reset.js')]);
  });

  test('root and inspect are required', () => {
    expect(() => scanSourceTree({ inspect })).toThrow(/root/);
    expect(() => scanSourceTree({ root })).toThrow(/inspect/);
  });
});
