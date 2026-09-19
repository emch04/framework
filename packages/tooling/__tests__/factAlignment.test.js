const {
  assertFactsAligned,
  compareFacts,
  extractMatches,
  pickPaths
} = require('../src/guards/factAlignment');

describe('compareFacts', () => {
  test('agrees when every claim matches the code', () => {
    const report = compareFacts({
      facts: { proPrice: 49, rate: 0.01, gateways: ['stripe', 'paypal'] },
      claims: { proPrice: 49, rate: 0.01, gateways: ['paypal', 'stripe'] }
    });
    expect(report).toEqual({ ok: true, mismatches: [], unextracted: [], unbacked: [], unstated: [] });
  });

  test('reports a rate the text rounds up and a list the text inflates', () => {
    const report = compareFacts({
      facts: { enterpriseRate: 0.005, gateways: ['stripe', 'paypal'] },
      claims: { enterpriseRate: 0.01, gateways: ['stripe', 'paypal', 'wire', 'cash'] }
    });
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((entry) => entry.key)).toEqual(['enterpriseRate', 'gateways']);
  });

  test('floating-point noise is not a disagreement; a real difference is', () => {
    expect(compareFacts({ facts: { r: 0.1 + 0.2 }, claims: { r: 0.3 } }).ok).toBe(true);
    expect(compareFacts({ facts: { r: 0.3 }, claims: { r: 0.30001 } }, { tolerance: 1e-9 }).ok).toBe(false);
  });

  test('two failed extractions are NOT an agreement', () => {
    const report = compareFacts({ facts: { price: undefined, fee: Number('x') }, claims: { price: undefined, fee: 3 } });
    expect(report.ok).toBe(false);
    expect(report.unextracted).toEqual([
      expect.objectContaining({ key: 'price', side: 'both' }),
      expect.objectContaining({ key: 'fee', side: 'fact' })
    ]);
  });

  test('a claim no fact backs is reported; a fact the text omits only when required', () => {
    const input = { facts: { a: 1, b: 2 }, claims: { a: 1, c: 3 } };
    expect(compareFacts(input).unbacked).toEqual([{ key: 'c', claim: 3 }]);
    expect(compareFacts({ facts: { a: 1, b: 2 }, claims: { a: 1 } }).ok).toBe(true);
    expect(compareFacts({ facts: { a: 1, b: 2 }, claims: { a: 1 } }, { requireEveryFact: true }).ok).toBe(false);
  });

  test('a list with an extra entry disagrees, whatever the order', () => {
    expect(compareFacts({ facts: { l: [1, 2] }, claims: { l: [1, 2, 3] } }).ok).toBe(false);
    expect(compareFacts({ facts: { l: [1, 2, 3] }, claims: { l: [1, 2] } }).ok).toBe(false);
  });

  test('strict array order when asked, and deep objects compared key by key', () => {
    expect(compareFacts({ facts: { l: [1, 2] }, claims: { l: [2, 1] } }, { arrayOrder: 'strict' }).ok).toBe(false);
    expect(compareFacts({ facts: { o: { a: 1, b: [2, 3] } }, claims: { o: { b: [3, 2], a: 1 } } }).ok).toBe(true);
    expect(compareFacts({ facts: { o: { a: 1 } }, claims: { o: { a: 1, extra: true } } }).ok).toBe(false);
  });

  test('a string price is not the number price', () => {
    expect(compareFacts({ facts: { p: 49 }, claims: { p: '49' } }).ok).toBe(false);
  });
});

describe('extraction helpers', () => {
  const config = `
    { key: "starter", price: "$19" },
    { key: "pro", price: "$49" },
  `;

  test('extractMatches takes group 1 and turns numeric captures into numbers', () => {
    expect(extractMatches(config, {
      starter: /key: "starter"[^}]*?price: "\$(\d+)"/,
      pro: /key: "pro"[^}]*?price: "\$(\d+)"/g,
      label: /key: "(\w+)"/,
      missing: /key: "enterprise"[^}]*?price: "\$(\d+)"/
    })).toEqual({ starter: 19, pro: 49, label: 'starter', missing: undefined });
  });

  test('extractMatches accepts a custom parser', () => {
    expect(extractMatches('rate=1%', { rate: /rate=(\d+)%/ }, { parse: (raw) => Number(raw) / 100 })).toEqual({ rate: 0.01 });
  });

  test('pickPaths reads dotted paths and yields undefined for a missing branch', () => {
    const doc = { plans: { pro: { price: 49 } }, fee: 0 };
    expect(pickPaths(doc, { pro: 'plans.pro.price', fee: 'fee', gone: 'plans.team.price' })).toEqual({ pro: 49, fee: 0, gone: undefined });
  });

  test('end to end: a knowledge file that drifted from the config fails with a readable message', () => {
    const knowledge = { plans: { starter: { price: 19 }, pro: { price: 39 } } };
    const facts = extractMatches(config, {
      starter: /key: "starter"[^}]*?price: "\$(\d+)"/,
      pro: /key: "pro"[^}]*?price: "\$(\d+)"/
    });
    const claims = pickPaths(knowledge, { starter: 'plans.starter.price', pro: 'plans.pro.price' });
    expect(() => assertFactsAligned({ facts, claims })).toThrow('pro: code says 49, text says 39');
    expect(assertFactsAligned({ facts, claims: { ...claims, pro: 49 } }).ok).toBe(true);
  });
});
