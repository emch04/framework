const { createDeterministicFallback } = require('../src');

const build = () => createDeterministicFallback({
  responders: {
    average: async ({ grades }) => {
      if (!grades || !grades.length) return null;
      const mean = grades.reduce((a, b) => a + b, 0) / grades.length;
      return { text: `La moyenne est de ${mean.toFixed(1)}/20.` };
    },
    attendance: async ({ absences }) => ({ text: `${absences} absence(s) ce trimestre.` })
  },
  classify: (input) => {
    const q = String(input.question || '').toLowerCase();
    if (q.includes('moyenne')) return 'average';
    if (q.includes('absence')) return 'attendance';
    return null;
  }
});

describe('deterministic fallback', () => {
  test('answers from data, without any model', async () => {
    const result = await build().answer({ question: 'Quelle est sa moyenne ?', grades: [12, 15, 9] });

    expect(result.handled).toBe(true);
    expect(result.answer.text).toBe('La moyenne est de 12.0/20.');
  });

  test('every fallback answer SAYS it is degraded', async () => {
    /* Serving a degraded answer as if nothing happened teaches users to
       distrust the good ones. */
    const result = await build().answer({ question: 'sa moyenne ?', grades: [10] });

    expect(result.answer.degraded).toBe(true);
  });

  test('a question with no deterministic answer is declined, not invented', async () => {
    const result = await build().answer({ question: 'Raconte-moi une histoire.' });

    expect(result).toEqual({ handled: false });
  });

  test('a responder that has nothing to say declines too', async () => {
    const result = await build().answer({ question: 'sa moyenne ?', grades: [] });

    expect(result).toEqual({ handled: false });
  });

  test('withFallback: the provider answer passes through untouched when it works', async () => {
    const result = await build().withFallback(
      async () => ({ text: 'Réponse du modèle.' }),
      { question: 'sa moyenne ?', grades: [10] }
    );

    expect(result).toEqual({ degraded: false, answer: { text: 'Réponse du modèle.' } });
  });

  test('withFallback: when the provider dies, the deterministic answer serves', async () => {
    const result = await build().withFallback(
      async () => { throw new Error('all providers down'); },
      { question: 'sa moyenne ?', grades: [12, 14] }
    );

    expect(result.degraded).toBe(true);
    expect(result.answer.text).toBe('La moyenne est de 13.0/20.');
  });

  test('withFallback: the provider error is CARRIED, not swallowed', async () => {
    /* Eating it silently would hide the outage from your own monitoring. */
    const result = await build().withFallback(
      async () => { throw new Error('groq: 503'); },
      { question: 'sa moyenne ?', grades: [10] }
    );

    expect(result.providerError.message).toBe('groq: 503');
  });

  test('withFallback: no fallback available means the original error surfaces', async () => {
    await expect(build().withFallback(
      async () => { throw new Error('all providers down'); },
      { question: 'raconte une blague' }
    )).rejects.toThrow('all providers down');
  });

  test('a string answer is shaped into an object and still marked', async () => {
    const fallback = createDeterministicFallback({
      responders: { greet: async () => 'Bonjour.' },
      classify: () => 'greet'
    });

    expect(await fallback.answer({})).toEqual({ handled: true, answer: { text: 'Bonjour.', degraded: true } });
  });

  test('the degraded marking can be customised', async () => {
    const fallback = createDeterministicFallback({
      responders: { greet: async () => ({ text: 'Bonjour.' }) },
      classify: () => 'greet',
      markDegraded: (answer) => ({ ...answer, source: 'sans-ia' })
    });

    expect((await fallback.answer({})).answer.source).toBe('sans-ia');
  });

  test('default classify reads input.intent', async () => {
    const fallback = createDeterministicFallback({ responders: { greet: async () => 'Salut.' } });

    expect((await fallback.answer({ intent: 'greet' })).handled).toBe(true);
    expect((await fallback.answer({ intent: 'other' })).handled).toBe(false);
  });

  test('a fallback with no responders is refused up front', () => {
    expect(() => createDeterministicFallback({})).toThrow(/responder/);
  });
});
