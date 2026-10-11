const { createPasswordRules } = require('../src');

const rules = () => createPasswordRules();

describe('per-condition checks', () => {
  test('each condition answers separately — the screen can tick them while typing', () => {
    const checks = rules().check('abc');

    expect(Object.fromEntries(checks.map((c) => [c.key, c.met]))).toEqual({
      length: false, lowercase: true, uppercase: false, digit: false, special: false
    });
  });

  test('a password meeting everything is valid', () => {
    expect(rules().isValid('Abcdef1!')).toBe(true);
  });

  test('one missing condition invalidates, and says WHICH', () => {
    const checks = rules().check('Abcdefg!');

    expect(rules().isValid('Abcdefg!')).toBe(false);
    expect(checks.find((c) => c.key === 'digit').met).toBe(false);
    expect(checks.filter((c) => !c.met)).toHaveLength(1);
  });

  test('the keys are translation keys, not sentences — the rule carries no language', () => {
    expect(rules().keys).toEqual(['length', 'lowercase', 'uppercase', 'digit', 'special']);
  });

  test('a non-string is treated as empty, not crashed on', () => {
    expect(rules().isValid(null)).toBe(false);
    expect(rules().isValid(undefined)).toBe(false);
    expect(() => rules().check(42)).not.toThrow();
  });
});

describe('strength and submission', () => {
  test('strength is the share of conditions met — feeds a progress bar', () => {
    expect(rules().strength('')).toBe(0);
    expect(rules().strength('abc')).toBe(0.2);
    expect(rules().strength('Abcdef1!')).toBe(1);
  });

  test('submission requires validity AND a matching confirmation', () => {
    expect(rules().canSubmit('Abcdef1!', 'Abcdef1!')).toBe(true);
    expect(rules().canSubmit('Abcdef1!', 'autre')).toBe(false);
    expect(rules().canSubmit('faible', 'faible')).toBe(false);
  });
});

describe('configuration', () => {
  test('the minimum length is adjustable', () => {
    const strict = createPasswordRules({ minLength: 12 });

    expect(strict.isValid('Abcdef1!')).toBe(false);
    expect(strict.isValid('Abcdefghij1!')).toBe(true);
    expect(strict.minLength).toBe(12);
  });

  test('the conditions themselves can be replaced', () => {
    const custom = createPasswordRules({
      conditions: [
        { key: 'length', test: (v, { minLength }) => v.length >= minLength },
        { key: 'no-spaces', test: (v) => !/\s/.test(v) }
      ]
    });

    expect(custom.keys).toEqual(['length', 'no-spaces']);
    expect(custom.isValid('sansespace')).toBe(true);
    expect(custom.isValid('avec espace')).toBe(false);
  });

  test('THE SAME MODULE runs on both ends — screen and server cannot drift', () => {
    /* The bug this replaces: one regex on the server, a diverging copy on the
       screen, and a password accepted on screen bouncing at submit. */
    const screen = createPasswordRules();
    const server = createPasswordRules();
    for (const candidate of ['Abcdef1!', 'faible', 'ABCDEF1!', 'Abcdefgh']) {
      expect(screen.isValid(candidate)).toBe(server.isValid(candidate));
    }
  });

  test('no conditions at all is a wiring mistake', () => {
    expect(() => createPasswordRules({ conditions: [] })).toThrow(/at least one condition/);
  });
});
