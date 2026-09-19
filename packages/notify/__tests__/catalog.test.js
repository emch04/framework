const { createNotificationCatalog } = require('../src');

/* The product's texts, not the package's: the package ships none. */
const NEUTRAL = { en: 'Open the app to view it.', fr: "Ouvrez l'application pour le consulter." };

const academic = {
  new_grade: {
    en: (p) => ({ title: 'New grade', message: `${p.student} received ${p.grade} in ${p.subject}.` }),
    fr: (p) => ({ title: 'Nouvelle note', message: `${p.student} a reçu ${p.grade} en ${p.subject}.` })
  },
  year_result: {
    en: (p) => ({ title: 'End-of-year result available', message: `${p.student} will repeat the year.`, pushBody: NEUTRAL.en }),
    fr: (p) => ({ title: 'Résultat de fin d\'année disponible', message: `${p.student} redoublera.`, pushBody: NEUTRAL.fr })
  }
};

const billing = {
  invoice_due: {
    en: { title: 'Invoice due', message: 'An invoice is waiting for payment.' }
  }
};

const build = (overrides = {}) => createNotificationCatalog({
  languages: ['en', 'fr', 'es'],
  entries: [academic, billing],
  ...overrides
});

describe('rendering in the recipient\'s language', () => {
  test('title and message in the requested language', () => {
    const rendered = build().render('new_grade', 'fr', { student: 'Ada', grade: '16/20', subject: 'maths' });

    expect(rendered).toMatchObject({ key: 'new_grade', language: 'fr', title: 'Nouvelle note', message: 'Ada a reçu 16/20 en maths.' });
  });

  test('a language not written for this key falls back to the default, and says so', () => {
    const rendered = build().render('invoice_due', 'fr');

    expect(rendered.language).toBe('en');
    expect(rendered.title).toBe('Invoice due');
  });

  test('a regional or unsupported tag is handled', () => {
    expect(build().render('new_grade', 'fr-CA', { student: 'A' }).language).toBe('fr');
    expect(build().render('new_grade', 'de', { student: 'A' }).language).toBe('en');
    expect(build().render('new_grade', undefined, { student: 'A' }).language).toBe('en');
  });

  test('entries may be plain objects as well as functions', () => {
    expect(build().render('invoice_due', 'en').message).toBe('An invoice is waiting for payment.');
  });

  test('an unknown key is a typo in the code, and throws', () => {
    expect(() => build().render('nope', 'en')).toThrow(/Unknown notification key: nope/);
  });
});

describe('the lock screen', () => {
  test('an entry with a neutral push body keeps the detail OFF the lock screen', () => {
    const rendered = build().render('year_result', 'en', { student: 'Ada' });

    expect(rendered.push).toEqual({ title: 'End-of-year result available', body: 'Open the app to view it.' });
    expect(rendered.push.body).not.toContain('repeat');
    expect(rendered.neutralPush).toBe(true);
  });

  test('the inbox, the screen and the email keep the full message', () => {
    expect(build().render('year_result', 'fr', { student: 'Ada' }).message).toBe('Ada redoublera.');
  });

  test('without a neutral body, the push carries the message', () => {
    const rendered = build().render('new_grade', 'en', { student: 'Ada', grade: 'A', subject: 'art' });

    expect(rendered.push.body).toBe(rendered.message);
    expect(rendered.neutralPush).toBe(false);
  });
});

describe('building the catalogue', () => {
  test('entries from several domains are merged', () => {
    expect(build().keys().sort()).toEqual(['invoice_due', 'new_grade', 'year_result']);
    expect(build().has('invoice_due')).toBe(true);
  });

  test('a key declared in two domains is an error, never a silent overwrite', () => {
    expect(() => build({ entries: [academic, { new_grade: { en: { title: 'x' } } }] })).toThrow(/"new_grade" is declared twice/);
  });

  test('every entry needs the default language — the fallback of all the others', () => {
    expect(() => build({ entries: { orphan: { fr: { title: 'x' } } } })).toThrow(/no "en" version/);
  });

  test('an undeclared language is a wiring mistake', () => {
    expect(() => build({ entries: { k: { en: { title: 'x' }, de: { title: 'y' } } } })).toThrow(/unknown language "de"/);
  });

  test('languages are required, and the default must be one of them', () => {
    expect(() => createNotificationCatalog({})).toThrow(/languages/);
    expect(() => build({ defaultLanguage: 'it' })).toThrow(/not in options.languages/);
  });
});

describe('audit', () => {
  test('a neutral push forgotten in one language is reported — it leaks only in that language', () => {
    const catalog = build({
      entries: {
        year_result: {
          en: (p) => ({ title: 'Result available', message: `${p.student} will repeat.`, pushBody: NEUTRAL.en }),
          fr: (p) => ({ title: 'Résultat disponible', message: `${p.student} redoublera.` })
        }
      }
    });

    expect(catalog.audit({ params: { year_result: { student: 'Ada' } } }).pushBodyGaps)
      .toEqual([{ key: 'year_result', languages: ['fr'] }]);
  });

  test('a parameter the template expected and did not get shows up as "undefined"', () => {
    const report = build().audit({ params: { new_grade: { student: 'Ada', grade: 'A' } } });

    expect(report.placeholders).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'new_grade', language: 'en', text: 'Ada received A in undefined.' })
    ]));
  });

  test('missing languages and throwing templates are listed', () => {
    const catalog = build({
      entries: {
        invoice_due: billing.invoice_due,
        fragile: { en: (p) => ({ title: p.deep.value }) }
      }
    });
    const report = catalog.audit();

    expect(report.missing).toEqual(expect.arrayContaining([
      { key: 'invoice_due', language: 'fr' },
      { key: 'invoice_due', language: 'es' }
    ]));
    expect(report.errors).toEqual([expect.objectContaining({ key: 'fragile', language: 'en' })]);
  });

  test('a complete catalogue with good samples is clean', () => {
    const catalog = build({ languages: ['en', 'fr'], entries: academic });
    const params = { new_grade: { student: 'Ada', grade: 'A', subject: 'art' }, year_result: { student: 'Ada' } };

    expect(catalog.audit({ params })).toEqual({ missing: [], pushBodyGaps: [], placeholders: [], errors: [] });
  });
});
