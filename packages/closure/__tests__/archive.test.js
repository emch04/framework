const { createArchiveBuilder, createScrubber, DEFAULT_NEVER_EXPORT } = require('../src');

describe('the scrubber', () => {
  test('a credential never survives into an archive', () => {
    const { scrub } = createScrubber();
    const row = {
      fullName: 'Jean Dupont', matricule: 'MAT-1',
      password: 'hash', refreshToken: 'tok', apiKey: 'sk_live_x', tokenVersion: 4, __v: 2
    };

    const clean = scrub(row);

    expect(clean).toEqual({ fullName: 'Jean Dupont', matricule: 'MAT-1' });
    for (const field of ['password', 'refreshToken', 'apiKey', 'tokenVersion', '__v']) {
      expect(field in clean).toBe(false);
    }
  });

  test('the default list covers the usual suspects', () => {
    expect(DEFAULT_NEVER_EXPORT).toEqual(expect.arrayContaining(['password', 'refreshToken', 'apiKey', 'webhookSecret']));
  });

  test('a product can extend the list without losing the defaults', () => {
    const { scrub } = createScrubber({ alsoNever: ['activationCode'] });

    const clean = scrub({ fullName: 'Jean', activationCode: 'ABC', password: 'x' });

    expect(clean).toEqual({ fullName: 'Jean' });
  });

  test('non-objects pass through untouched', () => {
    const { scrub } = createScrubber();

    expect(scrub(null)).toBeNull();
    expect(scrub('texte')).toBe('texte');
    expect(scrub([1, 2])).toEqual([1, 2]);
  });
});

describe('the archive builder', () => {
  const sections = (overrides = {}) => ([
    { name: 'students', read: async () => [{ fullName: 'Jean', password: 'hash' }] },
    { name: 'results', read: async () => [{ subject: 'Maths', score: 14 }] },
    ...(overrides.extra || [])
  ]);

  test('gathers every section, scrubbed, with its count', async () => {
    const builder = createArchiveBuilder({ sections: sections() });

    const archive = await builder.build('year-1');

    expect(archive.sections.students).toEqual([{ fullName: 'Jean' }]);
    expect(archive.sections.results).toEqual([{ subject: 'Maths', score: 14 }]);
    expect(archive.counts).toEqual({ students: 1, results: 1 });
    expect(archive.complete).toBe(true);
  });

  test('the scope reaches every reader', async () => {
    const seen = [];
    const builder = createArchiveBuilder({
      sections: [{ name: 'a', read: async (scope) => { seen.push(scope); return []; } }]
    });

    await builder.build({ yearId: 'y1', school: 's9' });

    expect(seen).toEqual([{ yearId: 'y1', school: 's9' }]);
  });

  test('ONE failed section does not empty the archive — and it is NAMED', async () => {
    /* An archive silently missing a section looks complete and is not. */
    const errors = [];
    const builder = createArchiveBuilder({
      logger: { error: (m) => errors.push(m) },
      sections: [
        ...sections(),
        { name: 'payments', read: async () => { throw new Error('vault unreachable'); } }
      ]
    });

    const archive = await builder.build('year-1');

    expect(archive.sections.students).toBeDefined();
    expect(archive.sections.payments).toBeUndefined();
    expect(archive.failed).toEqual([{ name: 'payments', reason: 'vault unreachable' }]);
    expect(archive.complete).toBe(false);
    expect(errors).toHaveLength(1);
  });

  test('a reader returning nothing reads as an empty section, not a crash', async () => {
    const builder = createArchiveBuilder({
      sections: [{ name: 'empty', read: async () => null }]
    });

    const archive = await builder.build('y');

    expect(archive.sections.empty).toEqual([]);
    expect(archive.counts.empty).toBe(0);
  });

  test('a custom scrubber applies to every row of every section', async () => {
    const builder = createArchiveBuilder({
      scrubber: createScrubber({ alsoNever: ['matricule'] }),
      sections: [{ name: 'students', read: async () => [{ fullName: 'Jean', matricule: 'M-1', password: 'x' }] }]
    });

    expect((await builder.build('y')).sections.students).toEqual([{ fullName: 'Jean' }]);
  });

  test('wiring mistakes are refused up front', () => {
    expect(() => createArchiveBuilder({ sections: [] })).toThrow(/at least one section/);
    expect(() => createArchiveBuilder({ sections: [{ name: 'x' }] })).toThrow(/read\(\)/);
  });
});
