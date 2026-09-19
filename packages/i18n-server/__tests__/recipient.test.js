const { createRecipientLanguage, createRecipientReloader } = require('../src');

const language = createRecipientLanguage({ languages: ['fr', 'en', 'es'] });
const withHeader = (value) => ({ headers: { 'accept-language': value } });

/* Interface in French, mail in English: the only case that tells the two
   fields apart, and the one that shipped wrong. */
const ACCOUNT = { id: 'u1', email: 'owner@example.test', fullName: 'Ada Owner', lang: 'fr', emailLang: 'en' };

describe('the language of a recipient', () => {
  test('the mail choice wins over the interface language', () => {
    expect(language.languageOf(ACCOUNT)).toBe('en');
  });

  test('"auto" follows the interface', () => {
    expect(language.languageOf({ ...ACCOUNT, emailLang: 'auto' })).toBe('fr');
  });

  test('no mail choice at all: the interface language', () => {
    expect(language.languageOf({ lang: 'es' })).toBe('es');
  });

  test('a mail choice we do not serve falls through to the interface, not to the default', () => {
    expect(language.languageOf({ lang: 'es', emailLang: 'de' })).toBe('es');
  });

  test('a regional tag is reduced to its language', () => {
    expect(language.languageOf({ emailLang: 'en-GB' })).toBe('en');
    expect(language.languageOf({ lang: 'ES' })).toBe('es');
  });

  test('no stored language: the request header, then the default', () => {
    expect(language.languageOf({}, withHeader('es-MX,es;q=0.9'))).toBe('es');
    expect(language.languageOf(null, withHeader('de'))).toBe('fr');
    expect(language.languageOf(undefined)).toBe('fr');
  });

  test('a stored language beats the header of whoever triggered the send', () => {
    /* An administrator browsing in French resets the password of an English
       reader: the mail is for the reader. */
    expect(language.languageOf(ACCOUNT, withHeader('fr-FR'))).toBe('en');
  });

  test('field names are configurable, dotted paths included', () => {
    const custom = createRecipientLanguage({
      languages: ['en', 'fr'],
      mailField: 'settings.mailLanguage',
      interfaceFields: ['locale', 'preferences.lang'],
      followValue: 'same'
    });

    expect(custom.languageOf({ settings: { mailLanguage: 'fr' }, locale: 'en' })).toBe('fr');
    expect(custom.languageOf({ settings: { mailLanguage: 'same' }, preferences: { lang: 'fr' } })).toBe('fr');
    expect(custom.fields).toEqual(['settings', 'locale', 'preferences']);
    expect(custom.choices).toEqual(['same', 'en', 'fr']);
  });

  test('the settings endpoint accepts every language plus "auto", and nothing else', () => {
    expect(language.choices).toEqual(['auto', 'fr', 'en', 'es']);
    expect(language.isChoice('en')).toBe(true);
    expect(language.isChoice('auto')).toBe(true);
    expect(language.isChoice('de')).toBe(false);
    expect(language.isChoice('')).toBe(false);
  });

  test('always returns a language we serve', () => {
    for (const recipient of [{ emailLang: 'zz' }, { lang: 42 }, { emailLang: {} }, 'not-an-object']) {
      expect(language.languages).toContain(language.languageOf(recipient));
    }
  });

  test('a resolver with no languages is refused up front', () => {
    expect(() => createRecipientLanguage({})).toThrow(/languages/);
  });
});

/* A store that PROJECTS like a database: a field absent from the selection is
   not returned. That is exactly the original defect — the language field left
   out of the list, and therefore invisible. */
function projectingStore(documents) {
  const calls = [];
  const load = async (id, fields, context) => {
    calls.push({ id, fields, context });
    const doc = documents[id];
    if (!doc) return null;
    return Object.fromEntries(Object.entries(doc).filter(([key]) => key === 'id' || fields.includes(key)));
  };
  return { load, calls };
}

describe('re-reading the recipient before writing', () => {
  const stored = { u1: { ...ACCOUNT, passwordHash: 'secret' } };

  test('the session alone does not know the mail language — which is why we re-read', () => {
    const session = { id: 'u1', role: 'owner', email: 'owner@example.test' };

    expect(language.languageOf(session)).toBe('fr');
  });

  test('a session user re-read with the language fields gets mail in the chosen language', async () => {
    const { load } = projectingStore(stored);
    const reloader = createRecipientReloader({ load, fields: ['email', 'fullName'], language });

    const recipient = await reloader.reload({ id: 'u1', role: 'owner' });

    expect(language.languageOf(recipient)).toBe('en');
  });

  test('the language fields are ALWAYS selected, even when the caller lists only what the mail shows', async () => {
    const { load, calls } = projectingStore(stored);
    const reloader = createRecipientReloader({ load, fields: ['email', 'fullName'], language });

    await reloader.reload('u1');

    expect(calls[0].fields).toEqual(expect.arrayContaining(['email', 'fullName', 'emailLang', 'lang']));
    expect(calls[0].fields).not.toContain('passwordHash');
  });

  test('what the store says wins over what the token carried', async () => {
    const { load } = projectingStore(stored);
    const reloader = createRecipientReloader({ load, fields: ['email'], language });

    const recipient = await reloader.reload({ id: 'u1', role: 'owner', email: 'stale@example.test', lang: 'es' });

    expect(recipient.email).toBe('owner@example.test');
    expect(recipient.role).toBe('owner');
    expect(language.languageOf(recipient)).toBe('en');
  });

  test('`_id` is accepted as well as `id`', async () => {
    const { load, calls } = projectingStore(stored);
    await createRecipientReloader({ load, language }).reload({ _id: 'u1' });

    expect(calls[0].id).toBe('u1');
  });

  test('the context reaches the loader — a role, a model, a tenant', async () => {
    const { load, calls } = projectingStore(stored);
    await createRecipientReloader({ load, language }).reload('u1', { model: 'Staff' });

    expect(calls[0].context).toEqual({ model: 'Staff' });
  });

  test('an account that cannot be read still gets its mail, in the fallback language', async () => {
    const warnings = [];
    const reloader = createRecipientReloader({
      load: async () => { throw new Error('store down'); },
      language,
      logger: { warn: (message) => warnings.push(message) }
    });

    const partial = { id: 'u1', email: 'owner@example.test' };
    const recipient = await reloader.reload(partial);

    expect(recipient).toEqual(partial);
    expect(language.languageOf(recipient)).toBe('fr');
    expect(warnings.join(' ')).toMatch(/store down/);
  });

  test('an unknown account returns what we had, and an id alone returns null', async () => {
    const { load } = projectingStore(stored);
    const reloader = createRecipientReloader({ load, language });

    expect(await reloader.reload({ id: 'ghost', email: 'x@example.test' })).toEqual({ id: 'ghost', email: 'x@example.test' });
    expect(await reloader.reload('ghost')).toBeNull();
  });

  test('no id: nothing is loaded', async () => {
    const { load, calls } = projectingStore(stored);
    const reloader = createRecipientReloader({ load, language });

    expect(await reloader.reload(null)).toBeNull();
    expect(await reloader.reload({ email: 'public@example.test' })).toEqual({ email: 'public@example.test' });
    expect(calls).toHaveLength(0);
  });

  test('a reloader that would select nothing is refused up front', () => {
    expect(() => createRecipientReloader({ load: async () => null })).toThrow(/selects nothing/);
    expect(() => createRecipientReloader({ fields: ['email'] })).toThrow(/load/);
  });
});
