const { createDataExporter } = require('../src');

describe('data export', () => {
  test('gathers every section it can produce', async () => {
    const exporter = createDataExporter({
      sources: [
        { key: 'account', collect: async (id) => ({ id, name: 'Jean' }) },
        { key: 'orders', collect: async () => [{ ref: 'A-1' }] }
      ]
    });

    const file = await exporter.export('user-1');

    expect(file.sections.account).toEqual({ id: 'user-1', name: 'Jean' });
    expect(file.sections.orders).toEqual([{ ref: 'A-1' }]);
    expect(file.complete).toBe(true);
    expect(file.exportedAt).toEqual(expect.any(String));
  });

  test('NAMES what it does not hold instead of staying silent about it', async () => {
    /* An export that quietly omits a section looks complete and is not.
       That is a compliance failure dressed as a feature. */
    const exporter = createDataExporter({
      sources: [
        { key: 'account', collect: async () => ({}) },
        { key: 'payments', label: 'Payment history', elsewhere: 'held by the billing service — ask support' }
      ]
    });

    const file = await exporter.export('user-1');

    expect(file.notIncluded).toEqual([
      { key: 'payments', label: 'Payment history', where: 'held by the billing service — ask support' }
    ]);
    expect(file.complete).toBe(false);
    expect(file.sections.payments).toBeUndefined();
  });

  test('one failing source does not sink the export — but it is named', async () => {
    const errors = [];
    const exporter = createDataExporter({
      logger: { error: (m) => errors.push(m) },
      sources: [
        { key: 'account', collect: async () => ({ name: 'Jean' }) },
        { key: 'messages', collect: async () => { throw new Error('archive unreachable'); } }
      ]
    });

    const file = await exporter.export('user-1');

    expect(file.sections.account).toEqual({ name: 'Jean' });
    expect(file.unavailable).toEqual([
      { key: 'messages', label: 'messages', reason: 'archive unreachable' }
    ]);
    expect(file.complete).toBe(false);
    expect(errors).toHaveLength(1);
  });

  test('the subject is passed to every collector', async () => {
    const seen = [];
    const exporter = createDataExporter({
      sources: [
        { key: 'a', collect: async (s) => { seen.push(s); return null; } },
        { key: 'b', collect: async (s) => { seen.push(s); return null; } }
      ]
    });

    await exporter.export({ id: 'user-1', role: 'parent' });

    expect(seen).toEqual([{ id: 'user-1', role: 'parent' }, { id: 'user-1', role: 'parent' }]);
  });

  test('lists the sources it knows', () => {
    const exporter = createDataExporter({
      sources: [{ key: 'account', collect: async () => ({}) }, { key: 'x', elsewhere: 'elsewhere' }]
    });

    expect(exporter.sources).toEqual(['account', 'x']);
  });

  test('a source with neither a collector nor a location is a wiring mistake', () => {
    expect(() => createDataExporter({ sources: [{ key: 'orphan' }] }))
      .toThrow(/needs either collect\(\) or elsewhere/);
  });

  test('a source without a key, or no sources at all, is refused up front', () => {
    expect(() => createDataExporter({ sources: [] })).toThrow(/at least one source/);
    expect(() => createDataExporter({ sources: [{ collect: async () => ({}) }] })).toThrow(/key/);
  });
});
