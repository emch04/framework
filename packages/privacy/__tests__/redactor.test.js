const { createRedactor } = require('../src');

const redactor = createRedactor();

describe('log redaction', () => {
  test('removes an email from a free-text line', () => {
    expect(redactor.redact('Échec de connexion pour jean.dupont@ecole.cd')).toBe('Échec de connexion pour [EMAIL]');
  });

  test('removes a phone number whatever its shape', () => {
    for (const number of ['+243 810 000 000', '0810000000', '+33 6 12 34 56 78', '06-12-34-56-78']) {
      expect(redactor.redact(`appelle le ${number}`)).toBe('appelle le [PHONE]');
    }
  });

  test('redacts a secret by FIELD NAME, whatever the value looks like', () => {
    const cleaned = redactor.redact({ password: 'x', token: 'y', apiKey: 'z', Authorization: 'w' });

    expect(Object.values(cleaned)).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]']);
  });

  test('keeps the field NAME — renaming it breaks whoever reads the log', () => {
    expect(Object.keys(redactor.redact({ password: 'x', userId: 42 }))).toEqual(['password', 'userId']);
  });

  test('leaves harmless values alone', () => {
    const cleaned = redactor.redact({ userId: 42, status: 'confirmed', count: 3, active: true });

    expect(cleaned).toEqual({ userId: 42, status: 'confirmed', count: 3, active: true });
  });

  test('reaches into nested objects and arrays', () => {
    const cleaned = redactor.redact({
      user: { email: 'jean@ecole.cd', profile: { phone: '+243810000000' } },
      events: [{ token: 'abc' }, { note: 'écrire à marie@ecole.cd' }]
    });

    expect(cleaned.user.email).toBe('[EMAIL]');
    expect(cleaned.user.profile.phone).toBe('[PHONE]');
    expect(cleaned.events[0].token).toBe('[REDACTED]');
    expect(cleaned.events[1].note).toBe('écrire à [EMAIL]');
  });

  test('does not mutate what it was given', () => {
    const original = { email: 'jean@ecole.cd' };

    redactor.redact(original);

    expect(original.email).toBe('jean@ecole.cd');
  });

  test('a structure pointing at itself does not loop forever', () => {
    const record = { email: 'jean@ecole.cd' };
    record.self = record;

    const cleaned = redactor.redact(record);

    expect(cleaned.email).toBe('[EMAIL]');
    expect(cleaned.self).toBe('[CIRCULAR]');
  });

  test('an absurdly deep structure is truncated instead of exhausting the stack', () => {
    let deep = { value: 'jean@ecole.cd' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };

    expect(() => redactor.redact(deep)).not.toThrow();
  });

  test('an Error keeps its shape, with message and stack cleaned', () => {
    const cleaned = redactor.redact(new Error('failed for jean@ecole.cd'));

    expect(cleaned.message).toBe('failed for [EMAIL]');
    expect(cleaned.name).toBe('Error');
  });

  test('a Date survives as a Date', () => {
    const date = new Date('2026-08-25T10:00:00Z');

    expect(redactor.redact({ at: date }).at).toEqual(date);
  });

  test('an inline secret in a stringified payload is caught', () => {
    const cleaned = redactor.redact('POST /login {"password":"hunter2","user":"jean"}');

    expect(cleaned).not.toContain('hunter2');
    expect(cleaned).toContain('password');
  });

  test('a bearer token in a header line is caught', () => {
    expect(redactor.redact('Authorization: Bearer eyJhbGciOi.JIUzI1NiJ9.abc')).not.toContain('eyJhbGciOi');
  });

  test('the same redactor works twice on the same input — no leftover regex state', () => {
    const line = 'jean@ecole.cd et marie@ecole.cd';

    expect(redactor.redact(line)).toBe(redactor.redact(line));
    expect(redactor.redact(line)).toBe('[EMAIL] et [EMAIL]');
  });

  test('extra patterns are added without losing the defaults', () => {
    const custom = createRedactor({ extra: [{ pattern: /MAT-\d{4}-\d{4}/g, replacement: '[MATRICULE]' }] });

    expect(custom.redact('MAT-2026-0001 pour jean@ecole.cd')).toBe('[MATRICULE] pour [EMAIL]');
  });

  test('an added pattern WINS over the generic defaults', () => {
    /* The default phone rule matches any long run of digits and would eat
       "2026-0001" first. Specific before generic, or a custom pattern never
       fires. */
    const custom = createRedactor({ extra: [{ pattern: /REF-[\d-]+/g, replacement: '[REF]' }] });

    expect(custom.redact('commande REF-2026-000112')).toBe('commande [REF]');
  });

  test('the whole pattern set can be replaced', () => {
    const minimal = createRedactor({ patterns: [], secretKeys: [] });

    expect(minimal.redact({ email: 'jean@ecole.cd' }).email).toBe('jean@ecole.cd');
  });

  test('null, undefined and primitives pass through', () => {
    expect(redactor.redact(null)).toBeNull();
    expect(redactor.redact(undefined)).toBeUndefined();
    expect(redactor.redact(42)).toBe(42);
    expect(redactor.redact(true)).toBe(true);
  });
});
