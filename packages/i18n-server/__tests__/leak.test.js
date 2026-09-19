const { createLanguageLeakCheck, createRecipientLanguage, visibleText, htmlLanguage } = require('../src');

const leak = createLanguageLeakCheck({
  markers: {
    fr: ['votre', 'vous', 'bonjour', 'réinitialiser', 'équipe', 'établissement'],
    en: ['your', 'you', 'hello', 'reset', 'team'],
    es: ['usted', 'hola', 'equipo']
  }
});

/* A small keyed dictionary and a renderer, standing in for the product's own. */
const DICT = {
  subject: { fr: 'Réinitialiser votre mot de passe', en: 'Reset your password', es: 'Restablecer su contraseña' },
  hello: { fr: 'Bonjour', en: 'Hello', es: 'Hola' },
  footer: { fr: "L'équipe", en: 'The team', es: 'El equipo' }
};

function renderMail(recipient, { hardcodedFooter } = {}) {
  const lang = createRecipientLanguage({ languages: ['fr', 'en', 'es'] }).languageOf(recipient);
  const tr = (key) => DICT[key][lang];
  const footer = hardcodedFooter || tr('footer');
  return {
    lang,
    subject: tr('subject'),
    text: `${tr('hello')} ${recipient.name}\n\n${footer}`,
    html: `<!doctype html><html lang="${lang}"><head><style>.vous{color:red}</style></head>`
      + `<body><p class="votre">${tr('hello')} ${recipient.name}</p><p>${footer}</p></body></html>`
  };
}

const ACCOUNT = { name: 'Ada', lang: 'fr', emailLang: 'en' };

describe('a mail rendered for one language contains no other', () => {
  test('interface in French, mail in English: nothing French reaches the reader', () => {
    const mail = renderMail(ACCOUNT);
    const result = leak.inspect(mail, 'en');

    expect(mail.lang).toBe('en');
    expect(leak.describe(result)).toEqual([]);
    expect(result.clean).toBe(true);
  });

  test('ONE hardcoded line is enough to fail — the defect this exists for', () => {
    const result = leak.inspect(renderMail(ACCOUNT, { hardcodedFooter: "L'équipe de votre établissement" }), 'en');

    expect(result.clean).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      { part: 'text', language: 'fr', match: 'votre' },
      { part: 'html', language: 'fr', match: 'établissement' }
    ]));
  });

  test('a mail that went out in the default language is caught by its subject', () => {
    const result = leak.inspect(renderMail({ name: 'Ada', lang: 'fr' }), 'en');

    expect(result.findings.some((f) => f.part === 'subject' && f.language === 'fr')).toBe(true);
    expect(result.findings).toContainEqual({ part: 'html', language: 'fr', match: '<html lang="fr">' });
  });

  test('styles, class names and tags are not what the reader reads', () => {
    /* `.vous` and class="votre" are in the markup, not in the text. */
    expect(leak.inspect({ html: renderMail(ACCOUNT).html }, 'en').clean).toBe(true);
  });

  test('a word is matched whole: "you" is not inside "youth", "pr" is not inside "pré"', () => {
    const check = createLanguageLeakCheck({ markers: { en: ['you'], fr: ['pr'] } });

    expect(check.inspect('youth club', 'fr').clean).toBe(true);
    expect(check.inspect('Thank you', 'fr').clean).toBe(false);
    expect(check.inspect('prévenir', 'en').clean).toBe(true);
  });

  test('matching ignores case, and a RegExp marker is accepted', () => {
    const check = createLanguageLeakCheck({ markers: { fr: [/\b(janvier|février)\b/i], en: ['HELLO'] } });

    expect(check.inspect('Due on 3 février', 'en').findings).toEqual([{ part: 'text', language: 'fr', match: 'février' }]);
    expect(check.inspect('hello', 'fr').clean).toBe(false);
  });

  test('the expected language is never checked against itself', () => {
    expect(leak.inspect({ subject: 'Bonjour, votre équipe' }, 'fr').clean).toBe(true);
  });

  test('a missing <html lang> can be required', () => {
    const strict = createLanguageLeakCheck({ markers: { fr: ['vous'] }, requireHtmlLang: true });

    expect(strict.inspect({ html: '<html><body>Hi</body></html>' }, 'en').findings)
      .toEqual([{ part: 'html', language: null, match: 'no <html lang>' }]);
    expect(leak.inspect({ html: '<html><body>Hi</body></html>' }, 'en').clean).toBe(true);
  });

  test('a regional lang attribute matches its language', () => {
    expect(leak.inspect({ html: '<html lang="en-GB"><body>Hi</body></html>' }, 'en').clean).toBe(true);
  });

  test('wiring mistakes are refused', () => {
    expect(() => createLanguageLeakCheck({})).toThrow(/markers/);
    expect(() => leak.inspect('text')).toThrow(/expected/);
  });
});

describe('helpers', () => {
  test('visibleText drops markup, decodes entities and collapses space', () => {
    expect(visibleText('<head><title>x</title></head><!-- c --><p>A &amp; B&nbsp;<b>C</b>&#233;</p><script>vous()</script>'))
      .toBe('A & B C é');
  });

  test('htmlLanguage reads the document language', () => {
    expect(htmlLanguage('<!doctype html><html dir="ltr" lang="FR">')).toBe('fr');
    expect(htmlLanguage('<html>')).toBeNull();
  });
});
