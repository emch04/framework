const { createAnonymizer } = require('../src');

const build = (overrides = {}) => createAnonymizer({
  fields: {
    fullName: 'redact',
    email: (_value, { token }) => `erased-${token}@invalid`,
    phone: 'clear',
    parentName: 'Anonymised parent'
  },
  ...overrides
});

const account = () => ({
  fullName: 'Jean Dupont',
  email: 'jean@ecole.cd',
  phone: '+243810000000',
  parentName: 'Marie Dupont',
  grades: [12, 15, 9],
  enrolledAt: '2026-09-01',
  classroom: 'CM2-A'
});

describe('anonymisation', () => {
  test('erases what identifies the person', async () => {
    const record = account();

    await build().anonymise(record);

    expect(record.fullName).toBe('Anonymised');
    expect(record.email).toMatch(/^erased-[0-9a-f]+@invalid$/);
    expect(record.phone).toBeUndefined();
    expect(record.parentName).toBe('Anonymised parent');
  });

  test('KEEPS the records that are not about identity', async () => {
    /* Grades, enrolment, invoices: they have their own legal retention and
       belong to the institution as much as to the person. Deleting the row
       would take them with it or leave them unexplainable. */
    const record = account();

    await build().anonymise(record);

    expect(record.grades).toEqual([12, 15, 9]);
    expect(record.enrolledAt).toBe('2026-09-01');
    expect(record.classroom).toBe('CM2-A');
  });

  test('no trace of the original values remains', async () => {
    const record = account();

    await build().anonymise(record);

    const dump = JSON.stringify(record);
    for (const value of ['Jean', 'Dupont', 'jean@ecole.cd', '243810000000', 'Marie']) {
      expect(dump).not.toContain(value);
    }
  });

  test('a field the record does not carry is skipped, never invented', async () => {
    /* Adding `parentPhone` to an employee record would be new personal data
       created by the erasure itself. */
    const record = { fullName: 'Jean', email: 'jean@x.cd' };

    const result = await build().anonymise(record);

    expect('phone' in record).toBe(false);
    expect(result.skipped).toEqual(['phone', 'parentName']);
    expect(result.changed).toEqual(['fullName', 'email']);
  });

  test('two anonymisations never produce the same marker', async () => {
    const a = await build().anonymise(account());
    const b = await build().anonymise(account());

    expect(a.token).not.toBe(b.token);
  });

  test('running it twice is harmless', async () => {
    const anonymizer = build();
    const record = account();

    await anonymizer.anonymise(record);
    const first = record.email;
    await anonymizer.anonymise(record);

    expect(record.fullName).toBe('Anonymised');
    expect(record.email).not.toBe(first);
    expect(record.grades).toEqual([12, 15, 9]);
  });

  test('onAnonymised handles what a field rewrite cannot', async () => {
    /* Invalidating sessions, dropping push subscriptions, revoking tokens. */
    const done = [];
    const anonymizer = build({
      onAnonymised: async (record, { token }) => {
        record.tokenVersion = (record.tokenVersion || 0) + 1000;
        done.push(token);
      }
    });
    const record = { ...account(), tokenVersion: 3 };

    const result = await anonymizer.anonymise(record);

    expect(record.tokenVersion).toBe(1003);
    expect(done).toEqual([result.token]);
  });

  test('a schema-aware `has` avoids inventing fields on a partial record', async () => {
    const schema = new Set(['fullName', 'email']);
    const anonymizer = build({ has: (_record, field) => schema.has(field) });
    const record = { fullName: 'Jean', email: 'jean@x.cd', phone: '0899' };

    const result = await anonymizer.anonymise(record);

    expect(record.phone).toBe('0899');
    expect(result.skipped).toContain('phone');
  });

  test('it does not save — persistence stays the caller\'s decision', async () => {
    let saved = false;
    const record = { ...account(), save: () => { saved = true; } };

    await build().anonymise(record);

    expect(saved).toBe(false);
  });

  test('wiring mistakes are refused up front', async () => {
    expect(() => createAnonymizer({ fields: {} })).toThrow(/at least one field/);
    await expect(build().anonymise(null)).rejects.toThrow(/record object/);
  });
});
