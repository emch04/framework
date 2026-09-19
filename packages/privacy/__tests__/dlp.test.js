const { createRedactor, luhnValid, ibanValid } = require('../src');

const redactor = createRedactor();

/* Fake keys are assembled at run time: written whole, they would trip the
   secret scanners (gitleaks, GitHub push protection) on every push. */
const FAKE_STRIPE_KEY = ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');
const FAKE_GITHUB_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const FAKE_SLACK_TOKEN = ['xoxb', '123456789012', 'abcdefghijkl'].join('-');
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
const PEM_EDGE = '-'.repeat(5);

describe('data loss prevention — what must be caught (false negatives)', () => {
  test('a valid card number, with or without separators', () => {
    for (const card of ['4111111111111111', '4111 1111 1111 1111', '5500-0000-0000-0004', '378282246310005']) {
      expect(redactor.redact(`paid with ${card} today`)).toBe('paid with [CARD] today');
    }
  });

  test('a valid IBAN, grouped or compact', () => {
    expect(redactor.redact('IBAN FR76 3000 6000 0112 3456 7890 189')).toBe('IBAN [IBAN]');
    expect(redactor.redact('to DE89370400440532013000.')).toBe('to [IBAN].');
    expect(redactor.redact('GB82WEST12345698765432')).toBe('[IBAN]');
  });

  test('an international phone number', () => {
    for (const phone of ['+243 810 000 000', '+243810000000', '+1 (415) 555-2671', '+44 20 7946 0958']) {
      expect(redactor.redact(`call ${phone}`)).toBe('call [PHONE]');
    }
  });

  test('a secret written inline, even as the suffix of a longer name', () => {
    /* "\btoken\b" never matched "access_token": "_" is a word character. */
    for (const line of ['access_token=abc123', 'refresh_token: "abc123"', 'client_secret=abc123', '{"api_key":"abc123"}', 'secret_key=abc123', 'db_password=abc123']) {
      expect(redactor.redact(line)).not.toContain('abc123');
    }
  });

  test('a secret held under a field name, whatever its spelling', () => {
    const cleaned = redactor.redact({ access_token: 'a', 'Access-Token': 'b', clientSecret: 'c', 'x-api-key': 'd', 'Set-Cookie': 'e' });

    expect(Object.values(cleaned)).toEqual(Array(5).fill('[REDACTED]'));
  });

  test('provider keys recognised by their prefix alone', () => {
    const lines = [
      `using ${FAKE_STRIPE_KEY}`,
      'key AKIAIOSFODNN7EXAMPLE here',
      FAKE_GITHUB_TOKEN,
      FAKE_SLACK_TOKEN
    ];
    for (const line of lines) expect(redactor.redact(line)).toContain('[API KEY]');
  });

  test('a JWT on its own, without "Bearer" in front', () => {
    expect(redactor.redact(`session ${FAKE_JWT}`)).toBe('session [JWT]');
  });

  test('credentials embedded in a URL', () => {
    expect(redactor.redact('connect mongodb+srv://admin:hunter2@cluster0.example.net/db'))
      .toBe('connect mongodb+srv://[REDACTED]@cluster0.example.net/db');
  });

  test('a private key block', () => {
    const block = `${PEM_EDGE}BEGIN RSA PRIVATE KEY${PEM_EDGE}\nMIIEow\nIBAAK\n${PEM_EDGE}END RSA PRIVATE KEY${PEM_EDGE}`;

    expect(redactor.redact(`key: ${block}`)).not.toContain('MIIEow');
  });

  test('a placeholder is never cut in half by a later rule', () => {
    expect(redactor.redact(`x-api-key: ${FAKE_STRIPE_KEY}`)).toBe('x-api-key: [API KEY]');
  });

  test('a password that happens to start with "[" still goes', () => {
    expect(redactor.redact('password=[hunter2')).toBe('password=[REDACTED]');
  });
});

describe('data loss prevention — what must be left alone (false positives)', () => {
  test('a timestamp keeps its date and time', () => {
    /* The loose phone rule used to turn this into "[PHONE]:00:00". */
    expect(redactor.redact('at 2026-09-19 10:00:00')).toBe('at 2026-09-19 10:00:00');
    expect(redactor.redact('at 2026-09-19T10:00:00Z')).toBe('at 2026-09-19T10:00:00Z');
  });

  test('a UUID keeps its last group', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';

    expect(redactor.redact(`request ${id}`)).toBe(`request ${id}`);
  });

  test('a card-shaped number that fails Luhn is not called a card', () => {
    expect(redactor.redact('ref 4111111111111112')).not.toContain('[CARD]');
  });

  test('an IBAN-shaped code that fails mod-97 is not called an IBAN', () => {
    expect(redactor.redact('FR76 3000 6000 0112 3456 7890 188')).not.toContain('[IBAN]');
  });

  test('ordinary prose, counts and versions pass through', () => {
    const line = 'tokens: 1500 used, monkey=banana, version 1.2.3, 42 students, room 101';

    expect(redactor.redact(line)).toBe(line);
  });
});

describe('data loss prevention — inspect() says what was found, never the values', () => {
  test('counts by rule name', () => {
    const { value, found, clean } = redactor.inspect({ note: 'jean@example.com and 4111111111111111', password: 'x' });

    expect(value).toEqual({ note: '[EMAIL] and [CARD]', password: '[REDACTED]' });
    expect(found).toEqual({ email: 1, card: 1, 'secret-key': 1 });
    expect(clean).toBe(false);
  });

  test('a clean message is reported clean', () => {
    expect(redactor.inspect('Bonjour, la réunion est jeudi.')).toEqual({ value: 'Bonjour, la réunion est jeudi.', found: {}, clean: true });
  });

  test('a match refused by validate() is not counted', () => {
    expect(redactor.inspect('FR76 3000 6000 0112 3456 7890 188').found.iban).toBeUndefined();
  });
});

describe('country and language patterns come from the caller', () => {
  test('a national identifier added through extra wins over the generic rules', () => {
    const custom = createRedactor({
      extra: [{ name: 'nir', pattern: /\b[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/g, replacement: '[NIR]' }]
    });

    expect(custom.redact('NIR 1 85 05 78 006 084 36')).toBe('NIR [NIR]');
  });

  test('an extra pattern can carry its own validate()', () => {
    const custom = createRedactor({
      patterns: [],
      extra: [{ name: 'even', pattern: /\d+/g, replacement: '[EVEN]', validate: (m) => Number(m) % 2 === 0 }]
    });

    expect(custom.redact('1 2 3 4')).toBe('1 [EVEN] 3 [EVEN]');
  });

  test('a non-global pattern is refused at wiring — it would leak every match after the first', () => {
    expect(() => createRedactor({ extra: [{ name: 'once', pattern: /x/, replacement: '' }] })).toThrow(/global/);
  });
});

describe('checksums', () => {
  test('Luhn', () => {
    expect(luhnValid('4111 1111 1111 1111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('123')).toBe(false);
  });

  test('IBAN mod-97', () => {
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
    expect(ibanValid('not an iban')).toBe(false);
  });
});
