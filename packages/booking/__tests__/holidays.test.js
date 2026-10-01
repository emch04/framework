const { getPublicHolidays, easterSunday, HOLIDAY_COUNTRIES, computeSlots } = require('../src');

test('Pâques et les fêtes mobiles', () => {
  expect(easterSunday(2026)).toBe('2026-04-05');
  expect(easterSunday(2027)).toBe('2027-03-28');
  const fr = getPublicHolidays('fr', 2026).map((f) => f.date);
  expect(fr).toEqual(expect.arrayContaining(['2026-04-06', '2026-05-14', '2026-05-25', '2026-07-14']));
  expect(fr).toHaveLength(11);
});

test('RDC : onze jours, dont le 30 juin et les ajouts de 2023', () => {
  const cd = getPublicHolidays('CD', 2026);
  expect(cd).toHaveLength(11);
  expect(cd.map((f) => f.id)).toEqual(expect.arrayContaining(['independence-day', 'simon-kimbangu', 'genocost']));
  expect(cd.find((f) => f.id === 'independence-day').date).toBe('2026-06-30');
});

test('un pays absent se fournit par l’application et s’applique aux créneaux', () => {
  expect(HOLIDAY_COUNTRIES).toEqual(expect.arrayContaining(['CD', 'FR', 'BE']));
  expect(() => getPublicHolidays('CG', 2026)).toThrow(RangeError);
  const calendars = { CG: (annee) => [{ date: `${annee}-08-15`, id: 'independence-day', name: 'Fête de l’indépendance' }] };
  expect(getPublicHolidays('CG', 2026, calendars)).toHaveLength(1);

  const ressource = { id: 'r', timeZone: 'Africa/Brazzaville', country: 'CG', weekly: { saturday: [['09:00', '10:00']] } };
  const fenetre = { service: { duration: 60 }, from: '2026-08-14T00:00:00Z', to: '2026-08-17T00:00:00Z', now: '2026-08-01T00:00:00Z' };
  expect(computeSlots({ resources: [ressource], ...fenetre, calendars })).toEqual([]);
  // holidays: false : la ressource travaille les jours fériés.
  expect(computeSlots({ resources: [{ ...ressource, holidays: false }], ...fenetre, calendars })).toHaveLength(1);
});
