const { sanitizeHeader, sanitizeAddress, formatSender, hasHeaderInjection } = require('../src');

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const LINE_SEP = String.fromCharCode(0x2028);

describe('header injection', () => {
  test('a newline in a subject cannot start a new header', () => {
    /* Left alone, everything after the break becomes a header of its own —
       a contact form turned into a silent Bcc. */
    const attack = `Commande confirmée${CR}${LF}Bcc: tout@le-monde.cd`;

    const safe = sanitizeHeader(attack);

    expect(safe).not.toContain(CR);
    expect(safe).not.toContain(LF);
    expect(safe).toBe('Commande confirmée Bcc: tout@le-monde.cd');
  });

  test('every flavour of line break is caught', () => {
    for (const breaker of [CR, LF, `${CR}${LF}`, NUL, LINE_SEP]) {
      expect(hasHeaderInjection(`avant${breaker}après`)).toBe(true);
      expect(sanitizeHeader(`avant${breaker}après`)).toBe('avant après');
    }
  });

  test('the words are kept, not dropped — a truncated subject is a bug you never solve', () => {
    expect(sanitizeHeader(`Facture${LF}n° 42`)).toBe('Facture n° 42');
  });

  test('ordinary text passes through untouched', () => {
    expect(sanitizeHeader('Votre commande est confirmée')).toBe('Votre commande est confirmée');
    expect(hasHeaderInjection('Votre commande est confirmée')).toBe(false);
  });

  test('runs of whitespace collapse', () => {
    expect(sanitizeHeader('  Trop   d espaces  ')).toBe('Trop d espaces');
  });

  test('an over-long value is cut rather than passed on', () => {
    expect(sanitizeHeader('a'.repeat(900), { maxLength: 100 })).toHaveLength(100);
  });

  test('null and undefined become an empty string, not the word "null"', () => {
    expect(sanitizeHeader(null)).toBe('');
    expect(sanitizeHeader(undefined)).toBe('');
  });
});

describe('addresses', () => {
  test('accepts a real address', () => {
    expect(sanitizeAddress('jean.dupont@ecole.cd')).toBe('jean.dupont@ecole.cd');
  });

  test('refuses what is not one, rather than passing it on', () => {
    /* An invalid Reply-To silently breaks every reply, and nobody reports it
       because the message itself arrived. */
    for (const bad of ['pas une adresse', 'jean@', '@ecole.cd', 'jean ecole.cd', '', null, undefined]) {
      expect(sanitizeAddress(bad)).toBeNull();
    }
  });

  test('an address carrying a break is refused, not repaired', () => {
    expect(sanitizeAddress(`jean@ecole.cd${CR}${LF}Bcc: x@y.cd`)).toBeNull();
  });
});

describe('sender', () => {
  test('formats a name and an address', () => {
    expect(formatSender('no-reply@acme.cd', 'Acme')).toBe('"Acme" <no-reply@acme.cd>');
  });

  test('a name carrying a break cannot escape its quotes', () => {
    const sender = formatSender('no-reply@acme.cd', `Acme${CR}${LF}Bcc: x@y.cd`);

    expect(sender).toBe('"Acme Bcc: x@y.cd" <no-reply@acme.cd>');
    expect(sender).not.toContain(LF);
  });

  test('a quote inside the name cannot close it early', () => {
    /* The smuggled address ends up INSIDE the display name's quotes, where it
       is inert — it is not a second recipient, just odd-looking text. */
    const sender = formatSender('no-reply@acme.cd', 'Acme" <evil@x.cd> "');

    expect(sender).toBe('"Acme <evil@x.cd>" <no-reply@acme.cd>');
    expect(sender.match(/"/g)).toHaveLength(2);
    expect(sender.endsWith('<no-reply@acme.cd>')).toBe(true);
  });

  test('without a name, the bare address is used', () => {
    expect(formatSender('no-reply@acme.cd')).toBe('no-reply@acme.cd');
    expect(formatSender('no-reply@acme.cd', '  ')).toBe('no-reply@acme.cd');
  });

  test('without a valid address there is no sender at all', () => {
    expect(formatSender('pas une adresse', 'Acme')).toBeNull();
    expect(formatSender(null)).toBeNull();
  });
});
