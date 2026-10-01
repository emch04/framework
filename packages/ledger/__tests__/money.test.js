const { createRateTable, createCurrencies, LedgerError } = require('../src');
const { convertir, diviserArrondi, lireTaux } = require('../src/money');

describe('devises', () => {
  const devises = createCurrencies();

  test('décimales ISO : CDF, USD, EUR à 2 ; XAF et XOF à 0', () => {
    expect(['CDF', 'USD', 'EUR', 'XAF', 'XOF'].map((c) => devises.decimals(c))).toEqual([2, 2, 2, 0, 0]);
    expect(() => devises.decimals('ZZZ')).toThrow(LedgerError);
    expect(createCurrencies({ GBP: 2 }).decimals('GBP')).toBe(2);
  });

  test('format lisible sans virgule flottante', () => {
    expect(devises.format(123456, 'USD')).toBe('1234.56');
    expect(devises.format(-5, 'CDF')).toBe('-0.05');
    expect(devises.format(655957, 'XAF')).toBe('655957');
  });
});

describe('conversion', () => {
  test('USD → CDF à 2850,50 : 12,34 USD = 35 175,17 CDF', () => {
    expect(convertir(1234, lireTaux('2850.50'), 2, 2)).toBe(3517517);
  });

  test('EUR → XAF (parité fixe 655,957) : change de décimales', () => {
    expect(convertir(100, lireTaux('655.957'), 2, 0)).toBe(656);
    expect(convertir(10000, lireTaux('655.957'), 2, 0)).toBe(65596);
  });

  test('XAF → EUR par le taux inverse exact', () => {
    const table = createRateTable({ rates: [{ from: 'EUR', to: 'XAF', date: '2026-01-01', rate: '655.957' }] });
    const t = table.rateAt('XAF', 'EUR', '2026-06-30');
    expect(t.inverted).toBe(true);
    expect(convertir(655957, t, 0, 2)).toBe(100000);
  });

  test('arrondi au demi le plus éloigné de zéro, dans les deux sens', () => {
    expect(diviserArrondi(5n, 2n)).toBe(3n);
    expect(diviserArrondi(-5n, 2n)).toBe(-3n);
    expect(diviserArrondi(7n, 3n)).toBe(2n);
  });

  test('taux à la date : le plus récent en vigueur, jamais un taux futur', () => {
    const table = createRateTable()
      .add({ from: 'USD', to: 'CDF', date: '2026-01-01', rate: '2800' })
      .add({ from: 'USD', to: 'CDF', date: '2026-03-01', rate: '2850.5' });
    expect(table.rateAt('USD', 'CDF', '2026-02-28')).toMatchObject({ num: 2800n, den: 1n, date: '2026-01-01' });
    expect(table.rateAt('USD', 'CDF', '2026-03-01')).toMatchObject({ num: 28505n, den: 10n });
    expect(() => table.rateAt('USD', 'CDF', '2025-12-31')).toThrow(/Aucun taux/);
  });

  test('taux invalides refusés', () => {
    expect(() => lireTaux('-1')).toThrow(LedgerError);
    expect(() => lireTaux('0')).toThrow(/nul/);
    expect(() => lireTaux('1e5')).toThrow(LedgerError);
    expect(() => createRateTable().add({ from: 'USD', to: 'USD', date: '2026-01-01', rate: '1' })).toThrow(/différentes/);
  });
});
