const { createCredentialCatalog } = require('../src');

const spaces = [
  {
    id: 'ai',
    label: 'AI providers',
    hint: 'Tried in order.',
    keys: [
      { key: 'GROQ_API_KEY', label: 'Groq', help: 'First provider.', where: 'console.groq.com' },
      { key: 'PUBLIC_CLIENT_ID', label: 'OAuth client id', secret: false }
    ]
  }
];

describe('credential catalog', () => {
  test('describes a managed key and defaults it to secret', () => {
    const catalog = createCredentialCatalog({ spaces });

    expect(catalog.has('GROQ_API_KEY')).toBe(true);
    expect(catalog.describe('GROQ_API_KEY')).toMatchObject({
      label: 'Groq',
      secret: true,
      space: 'ai',
      where: 'console.groq.com'
    });
  });

  test('honours secret: false for values that are not secrets', () => {
    const catalog = createCredentialCatalog({ spaces });

    expect(catalog.isSecret('PUBLIC_CLIENT_ID')).toBe(false);
  });

  test('an unlisted key is not managed', () => {
    const catalog = createCredentialCatalog({ spaces });

    expect(catalog.has('ANYTHING_ELSE')).toBe(false);
    expect(catalog.describe('ANYTHING_ELSE')).toBeNull();
  });

  test('keys() returns every managed name, flat', () => {
    const catalog = createCredentialCatalog({ spaces });

    expect(catalog.keys()).toEqual(['GROQ_API_KEY', 'PUBLIC_CLIENT_ID']);
  });

  test('reserved keys are recognised and never managed', () => {
    const catalog = createCredentialCatalog({ spaces, reservedKeys: ['ENCRYPTION_KEY'] });

    expect(catalog.isReserved('ENCRYPTION_KEY')).toBe(true);
    expect(catalog.has('ENCRYPTION_KEY')).toBe(false);
  });

  test('the same key declared twice is a wiring mistake, not a silent overwrite', () => {
    const duplicated = [{ id: 'a', keys: [{ key: 'K' }] }, { id: 'b', keys: [{ key: 'K' }] }];

    expect(() => createCredentialCatalog({ spaces: duplicated })).toThrow(/twice/);
  });

  test('a key that is both managed and reserved is refused', () => {
    expect(() => createCredentialCatalog({ spaces, reservedKeys: ['GROQ_API_KEY'] }))
      .toThrow(/both managed and reserved/);
  });

  test('an empty catalogue is refused: a free-text key list is the thing this prevents', () => {
    expect(() => createCredentialCatalog({ spaces: [] })).toThrow(/at least one space/);
  });
});
