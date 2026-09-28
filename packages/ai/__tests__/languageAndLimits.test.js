const { createAskLimit, createLanguageDetector } = require('../src');

const words = {
  fr: ['le', 'la', 'les', 'un', 'une', 'des', 'et', 'est', 'je', 'tu', 'que', 'pour', 'dans', 'merci', 'bonjour', 'oui', 'non', 'comment', 'pourquoi', 'mon', 'ma'],
  en: ['the', 'a', 'an', 'and', 'is', 'are', 'i', 'you', 'what', 'how', 'why', 'for', 'in', 'thanks', 'thank', 'hello', 'yes', 'no', 'my', 'please']
};

describe('createLanguageDetector', () => {
  test('the small words decide a short message no identifier can', async () => {
    const detector = createLanguageDetector({ words });
    expect(detector.byWords('merci')).toBe('fr');
    expect(detector.byWords('thank you')).toBe('en');
    expect(await detector.reply('merci', 'en')).toBe('fr');
  });

  test('mixed small words that do not lean clearly decide nothing: the app language stays', async () => {
    const detector = createLanguageDetector({ words });
    expect(detector.byWords('le the')).toBeNull();
    expect(await detector.reply('le the', 'fr')).toBe('fr');
  });

  test('a confident identifier wins; a doubtful one is not believed', async () => {
    const sure = createLanguageDetector({ words, identify: async () => ({ language: 'en', confidence: 0.8 }) });
    expect(await sure.reply('Could you summarise the meeting notes from yesterday', 'fr')).toBe('en');
    const unsure = createLanguageDetector({ words, identify: async () => ({ language: 'en', confidence: 0.3 }) });
    expect(await unsure.reply('Peux-tu résumer la réunion', 'fr')).toBe('fr');
  });

  test('a very short message needs far more confidence', async () => {
    const detector = createLanguageDetector({ words, identify: async () => ({ language: 'en', confidence: 0.7 }) });
    expect(await detector.reply('ok', 'fr')).toBe('fr');
  });

  test('a confidently identified but unsupported language keeps the small words\' vote, else the app language', async () => {
    const detector = createLanguageDetector({ words, identify: async () => ({ language: 'es', confidence: 0.99 }) });
    expect(await detector.reply('¿Cómo estás hoy, amigo mío?', 'en')).toBe('en');
  });

  test('the identifier out of reach: the small words alone', async () => {
    const detector = createLanguageDetector({ words, identify: async () => { throw new Error('model not loaded'); } });
    expect(await detector.reply('how are you and what is new', 'fr')).toBe('en');
  });

  test('an empty message, or an unsupported app language, falls back', async () => {
    const detector = createLanguageDetector({ words, fallback: 'en' });
    expect(await detector.reply('   ', 'fr')).toBe('fr');
    expect(await detector.reply('', 'de')).toBe('en');
  });

  test('two languages at least', () => {
    expect(() => createLanguageDetector({ words: { fr: ['le'] } })).toThrow(/two languages/);
  });
});

describe('createAskLimit', () => {
  test('allows max asks in the window, then refuses with a code and the wait — never a sentence', () => {
    const limit = createAskLimit({ max: 2, windowMs: 60_000, code: 'CHAT_RATE_LIMITED' });
    limit.take('u1', 0);
    limit.take('u1', 1_000);
    let error;
    try { limit.take('u1', 2_000); } catch (e) { error = e; }
    expect(error).toMatchObject({ statusCode: 429, code: 'CHAT_RATE_LIMITED', retryInMs: 58_000 });
  });

  test('the window slides: an old ask stops counting', () => {
    const limit = createAskLimit({ max: 1, windowMs: 10_000 });
    limit.take('u1', 0);
    expect(limit.peek('u1', 9_999).allowed).toBe(false);
    expect(limit.take('u1', 10_000).allowed).toBe(true);
  });

  test('each person has their own counter', () => {
    const limit = createAskLimit({ max: 1, windowMs: 10_000 });
    limit.take('u1', 0);
    expect(() => limit.take('u2', 0)).not.toThrow();
  });

  test('a refused ask is not counted: waiting is enough to be let back in', () => {
    const limit = createAskLimit({ max: 1, windowMs: 10_000 });
    limit.take('u1', 0);
    for (let t = 1; t < 5; t += 1) expect(() => limit.take('u1', t * 1000)).toThrow();
    expect(limit.take('u1', 10_000).allowed).toBe(true);
  });

  test('accounts that stopped asking are forgotten — the map does not grow forever', () => {
    const limit = createAskLimit({ max: 5, windowMs: 1_000, sweepEvery: 3 });
    limit.take('a', 0);
    limit.take('b', 0);
    expect(limit.size()).toBe(2);
    limit.take('c', 5_000);
    expect(limit.size()).toBe(1);
  });

  test('wiring mistakes are refused', () => {
    expect(() => createAskLimit({ max: 0, windowMs: 1 })).toThrow(/max/);
    expect(() => createAskLimit({ max: 1 })).toThrow(/windowMs/);
  });
});
