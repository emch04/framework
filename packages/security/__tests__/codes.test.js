const { createRandomCode, generateUniqueCodes } = require('../src');

describe('createRandomCode', () => {
  test('generates a code without prefix', () => {
    const code = createRandomCode();
    expect(code).toMatch(/^[0-9A-F]{10}$/);
  });

  test('prefixes and uppercases the code', () => {
    const code = createRandomCode({ prefix: 'ete2026' });
    expect(code).toMatch(/^ETE2026-[0-9A-F]{10}$/);
  });

  test('strips non alphanumeric characters and truncates the prefix', () => {
    const code = createRandomCode({ prefix: 'a!b c-très-long-préfixe-métier' });
    expect(code.split('-')[0]).toMatch(/^[A-Z0-9]{1,12}$/);
    expect(code).not.toMatch(/[ÉÈ!]/);
  });

  test('honors a custom tokenBytes length', () => {
    const code = createRandomCode({ tokenBytes: 2 });
    expect(code).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe('generateUniqueCodes', () => {
  test('generates the requested quantity, all distinct', async () => {
    const codes = await generateUniqueCodes({ quantity: 20, prefix: 'PROMO' });
    expect(codes).toHaveLength(20);
    expect(new Set(codes).size).toBe(20);
    codes.forEach((code) => expect(code).toMatch(/^PROMO-[0-9A-F]{10}$/));
  });

  test('retries only the codes rejected by isTaken, until the quantity is met', async () => {
    let call = 0;
    const isTaken = jest.fn(async (candidates) => {
      call += 1;
      // Le premier lot est entièrement rejeté (simule une collision avec le store) ; le suivant passe.
      return call === 1 ? new Set(candidates) : new Set();
    });

    const codes = await generateUniqueCodes({ quantity: 3, isTaken });

    expect(codes).toHaveLength(3);
    expect(isTaken).toHaveBeenCalledTimes(2);
  });

  test('throws after maxAttempts if it can never satisfy isTaken', async () => {
    const isTaken = async (candidates) => new Set(candidates);

    await expect(generateUniqueCodes({ quantity: 1, isTaken, maxAttempts: 2 }))
      .rejects.toThrow('Unable to generate enough unique codes after multiple attempts');
  });

  test('works without isTaken (uniqueness only within the batch)', async () => {
    const codes = await generateUniqueCodes({ quantity: 5 });
    expect(codes).toHaveLength(5);
  });
});
