const { createCommissionSchedule } = require('../src');

const build = () => createCommissionSchedule({ defaultRate: 0.01, rates: { enterprise: 0.005, internal: 0 } });

describe('commission schedule', () => {
  test('applies the default rate', () => {
    expect(build().commissionOn(10000, 'pro')).toEqual({ rate: 0.01, commission: 100, net: 9900 });
  });

  test('a plan-specific rate wins over the default', () => {
    expect(build().commissionOn(10000, 'enterprise')).toEqual({ rate: 0.005, commission: 50, net: 9950 });
  });

  test('a zero rate is honoured, not treated as missing', () => {
    expect(build().commissionOn(10000, 'internal')).toEqual({ rate: 0, commission: 0, net: 10000 });
  });

  test('an unknown plan pays the default rate', () => {
    expect(build().rateFor('whatever')).toBe(0.01);
  });

  test('the commission is a whole minor unit — no fractions of a cent', () => {
    const { commission, net } = build().commissionOn(1055, 'pro');

    expect(Number.isInteger(commission)).toBe(true);
    expect(commission + net).toBe(1055);
  });

  test('commission and net always add back up to the amount', () => {
    const schedule = build();
    for (const amount of [0, 1, 7, 99, 100, 3333, 999999]) {
      const { commission, net } = schedule.commissionOn(amount, 'pro');
      expect(commission + net).toBe(amount);
    }
  });

  test('rounding can be replaced when a currency has no minor unit', () => {
    const schedule = createCommissionSchedule({ defaultRate: 0.01, round: Math.ceil });

    expect(schedule.commissionOn(1010, 'pro').commission).toBe(11);
  });

  test('a negative amount is a caller mistake, not a negative commission', () => {
    expect(() => build().commissionOn(-100, 'pro')).toThrow(/non-negative/);
  });

  test('a missing or negative default rate is refused up front', () => {
    expect(() => createCommissionSchedule({})).toThrow(/defaultRate/);
    expect(() => createCommissionSchedule({ defaultRate: -0.01 })).toThrow(/defaultRate/);
  });

  test('a bad per-plan rate names the plan', () => {
    expect(() => createCommissionSchedule({ defaultRate: 0.01, rates: { pro: -1 } })).toThrow(/"pro"/);
  });
});
