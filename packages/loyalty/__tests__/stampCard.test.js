const { createStampCard } = require('../src');

const carte = createStampCard();
const visites = (...dates) => dates.map((date, index) => ({ id: `v${index + 1}`, date }));

describe('cycleEnd', () => {
  test('trois mois et demi par défaut, fin exclue', () => {
    expect(carte.cycleEnd('2026-01-01')).toBe('2026-04-16');
  });

  test('le mois d’arrivée trop court plafonne au dernier jour au lieu de glisser en mars', () => {
    expect(createStampCard({ window: { months: 3 } }).cycleEnd('2025-11-30')).toBe('2026-02-28');
  });

  test('refuse une date qui n’est pas un jour civil', () => {
    expect(() => carte.cycleEnd('2026-01-01T10:00:00Z')).toThrow(TypeError);
  });
});

describe('evaluate', () => {
  test('sans visite : tout le seuil reste à faire', () => {
    expect(carte.evaluate({ visits: [] })).toEqual({
      cycleStart: null, cycleEnd: null, count: 0, remaining: 7, reached: false, shouldGrant: false
    });
  });

  test('sept visites dans la fenêtre ouvrent la récompense', () => {
    const bilan = carte.evaluate({ visits: visites('2026-01-01', '2026-01-10', '2026-01-20', '2026-02-01', '2026-02-10', '2026-02-20', '2026-03-01') });
    expect(bilan).toMatchObject({ cycleStart: '2026-01-01', count: 7, remaining: 0, reached: true, shouldGrant: true });
  });

  test('une visite après la fin du cycle ouvre un cycle neuf, le reste est perdu', () => {
    const bilan = carte.evaluate({ visits: visites('2026-01-01', '2026-02-01', '2026-03-01', '2026-05-01') });
    expect(bilan).toMatchObject({ cycleStart: '2026-05-01', count: 1, remaining: 6 });
  });

  test('une récompense déjà inscrite sur le cycle ne se réaccorde pas', () => {
    const liste = visites('2026-01-01', '2026-01-10', '2026-01-20', '2026-02-01', '2026-02-10', '2026-02-20', '2026-03-01', '2026-03-05');
    const bilan = carte.evaluate({ visits: liste, reward: { status: 'lost', cycleStart: '2026-01-01' } });
    expect(bilan).toMatchObject({ reached: true, shouldGrant: false });
  });

  test('la visite récompense consommée remet le compteur à zéro tout de suite, sans compter', () => {
    const liste = [
      ...visites('2026-01-01', '2026-01-10', '2026-01-20', '2026-02-01', '2026-02-10', '2026-02-20', '2026-03-01'),
      { id: 'offerte', date: '2026-03-05', redeemed: true },
      { id: 'apres', date: '2026-03-10' }
    ];
    expect(carte.evaluate({ visits: liste })).toMatchObject({ cycleStart: '2026-03-10', count: 1, remaining: 6, shouldGrant: false });
  });

  test('données anciennes : la récompense utilisée désigne sa visite par identifiant', () => {
    const liste = [...visites('2026-01-01', '2026-01-02'), { id: 'offerte', date: '2026-01-03' }];
    const bilan = carte.evaluate({ visits: liste, reward: { status: 'used', visitId: 'offerte', cycleStart: '2025-10-01' } });
    expect(bilan).toMatchObject({ cycleStart: null, count: 0 });
  });

  test('seuil et fenêtre se paramètrent', () => {
    const courte = createStampCard({ threshold: 3, window: { days: 30 } });
    expect(courte.evaluate({ visits: visites('2026-01-01', '2026-01-15', '2026-01-25') })).toMatchObject({ reached: true, cycleEnd: '2026-01-31' });
  });
});

test('isRewardAvailable', () => {
  expect(carte.isRewardAvailable({ status: 'available' })).toBe(true);
  expect(carte.isRewardAvailable({ status: 'reserved' })).toBe(false);
  expect(carte.isRewardAvailable(null)).toBe(false);
});

test('les options invalides sont refusées tôt', () => {
  expect(() => createStampCard({ threshold: 0 })).toThrow(TypeError);
  expect(() => createStampCard({ window: {} })).toThrow(TypeError);
});
