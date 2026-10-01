const { computeSlots, wallTimeToISO } = require('../src');

/* Semaine du lundi 29 juin 2026 à Kinshasa (UTC+1, sans heure d'été).
   Le mardi 30 juin est la fête de l'indépendance en RDC. */
const barbier = {
  id: 'barbier-1',
  timeZone: 'Africa/Kinshasa',
  country: 'CD',
  weekly: {
    monday: [['09:00', '12:00'], ['14:00', '18:00']],
    tuesday: [['09:00', '12:00'], ['14:00', '18:00']],
    wednesday: [['09:00', '12:00'], ['14:00', '18:00']],
    thursday: [['09:00', '12:00'], ['14:00', '18:00']],
    friday: [['09:00', '12:00'], ['14:00', '18:00']],
    saturday: [['09:00', '13:00']]
  },
  exceptions: [
    { date: '2026-07-01', closed: true, reason: 'congé' },
    { date: '2026-07-03', intervals: [['10:00', '12:00']] },
    { date: '2026-07-05', intervals: [['10:00', '11:00']] } // un dimanche ouvert exceptionnellement
  ]
};
const coupe = { duration: 30, bufferBefore: 5, bufferAfter: 10 };
const SEMAINE = { from: '2026-06-28T23:00:00Z', to: '2026-07-05T23:00:00Z', now: '2026-06-28T12:00:00Z' };

const parJour = (creneaux) => creneaux.reduce((acc, c) => ({ ...acc, [c.local.date]: (acc[c.local.date] || 0) + 1 }), {});

describe('une semaine de créneaux', () => {
  test('horaires de la semaine, jour férié, congé, horaires spéciaux, dimanche ouvert', () => {
    const creneaux = computeSlots({ resources: [barbier], service: coupe, ...SEMAINE });
    expect(parJour(creneaux)).toEqual({
      '2026-06-29': 14, // 6 le matin + 8 l'après-midi
      // 30 juin : férié ; 1er juillet : congé
      '2026-07-02': 14,
      '2026-07-03': 4,
      '2026-07-04': 8,
      '2026-07-05': 2
    });
    expect(creneaux[0]).toEqual({
      start: '2026-06-29T08:00:00.000Z',
      end: '2026-06-29T08:30:00.000Z',
      resourceIds: ['barbier-1'],
      available: 1,
      local: { date: '2026-06-29', time: '09:00', offset: '+01:00' }
    });
  });

  test('les tampons des deux rendez-vous écartent les créneaux voisins', () => {
    // Rendez-vous déjà pris lundi 10:00–10:30 (tampons 5 avant, 10 après) : plage occupée 09:55–10:40.
    const bookings = [{ id: 'b1', resourceIds: ['barbier-1'], start: wallTimeToISO('2026-06-29', '10:00', 'Africa/Kinshasa'), end: wallTimeToISO('2026-06-29', '10:30', 'Africa/Kinshasa'), bufferBefore: 5, bufferAfter: 10, status: 'confirmed' }];
    const lundi = computeSlots({ resources: [barbier], service: coupe, ...SEMAINE, bookings })
      .filter((c) => c.local.date === '2026-06-29' && c.local.time < '12:00')
      .map((c) => c.local.time);
    // 09:30 (09:25–10:10), 10:00 et 10:30 (10:25–11:10) touchent la plage occupée.
    expect(lundi).toEqual(['09:00', '11:00', '11:30']);

    // Sans tampons ni d'un côté ni de l'autre, seul 10:00 tombe.
    const sansTampons = computeSlots({
      resources: [barbier], service: { duration: 30 }, ...SEMAINE,
      bookings: [{ ...bookings[0], bufferBefore: 0, bufferAfter: 0 }]
    }).filter((c) => c.local.date === '2026-06-29' && c.local.time < '12:00').map((c) => c.local.time);
    expect(sansTampons).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  test('un rendez-vous annulé ne bloque rien ; une indisponibilité externe bloque tout', () => {
    const annule = { id: 'b1', resourceIds: ['barbier-1'], start: '2026-06-29T08:00:00Z', end: '2026-06-29T08:30:00Z', status: 'cancelled' };
    const busy = [{ resourceId: 'barbier-1', start: '2026-06-29T13:00:00Z', end: '2026-06-29T14:00:00Z' }];
    const lundi = computeSlots({ resources: [barbier], service: { duration: 30 }, ...SEMAINE, bookings: [annule], busy })
      .filter((c) => c.local.date === '2026-06-29').map((c) => c.local.time);
    expect(lundi).toContain('09:00');
    expect(lundi).not.toContain('14:00');
    expect(lundi).not.toContain('14:30');
    expect(lundi).toContain('15:00');
  });

  test('pas de créneau plus court que la prestation en fin de plage, pas personnalisé', () => {
    const creneaux = computeSlots({ resources: [barbier], service: { duration: 45, step: 15 }, ...SEMAINE })
      .filter((c) => c.local.date === '2026-07-03').map((c) => c.local.time);
    expect(creneaux).toEqual(['10:00', '10:15', '10:30', '10:45', '11:00', '11:15']);
  });
});

describe('préavis et horizon', () => {
  test('préavis de 2 h et horizon de 3 jours depuis lundi 10:10', () => {
    const creneaux = computeSlots({
      resources: [barbier],
      service: { duration: 30, minNotice: 120, horizon: 3 },
      from: SEMAINE.from,
      to: SEMAINE.to,
      now: wallTimeToISO('2026-06-29', '10:10', 'Africa/Kinshasa')
    });
    expect(creneaux[0].local).toMatchObject({ date: '2026-06-29', time: '14:00' });
    const jeudi = creneaux.filter((c) => c.local.date === '2026-07-02').map((c) => c.local.time);
    expect(jeudi).toEqual(['09:00', '09:30', '10:00']); // l'horizon tombe jeudi 10:10
    expect(creneaux.some((c) => c.local.date > '2026-07-02')).toBe(false);
  });
});

describe('fuseaux et changements d’heure', () => {
  const paris = (weekly) => ({ id: 'salle-paris', timeZone: 'Europe/Paris', weekly });
  const tousLesJours = (plages) => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((j) => [j, plages]));

  test('09:00 à Paris : 08:00 UTC avant le passage à l’heure d’été, 07:00 UTC après', () => {
    const creneaux = computeSlots({
      resources: [paris(tousLesJours([['09:00', '10:00']]))],
      service: { duration: 60 },
      from: '2026-03-27T00:00:00Z', to: '2026-03-31T00:00:00Z', now: '2026-03-01T00:00:00Z'
    });
    expect(creneaux.map((c) => [c.local.date, c.local.time, c.local.offset, c.start])).toEqual([
      ['2026-03-27', '09:00', '+01:00', '2026-03-27T08:00:00.000Z'],
      ['2026-03-28', '09:00', '+01:00', '2026-03-28T08:00:00.000Z'],
      ['2026-03-29', '09:00', '+02:00', '2026-03-29T07:00:00.000Z'],
      ['2026-03-30', '09:00', '+02:00', '2026-03-30T07:00:00.000Z']
    ]);
  });

  test('nuit du passage à l’heure d’été : l’heure 02:00–03:00 n’existe pas, la plage dure 2 h', () => {
    const creneaux = computeSlots({
      resources: [paris({ sunday: [['01:00', '04:00']] })],
      service: { duration: 30 },
      from: '2026-03-28T00:00:00Z', to: '2026-03-30T00:00:00Z', now: '2026-03-01T00:00:00Z'
    });
    expect(creneaux.map((c) => c.local.time)).toEqual(['01:00', '01:30', '03:00', '03:30']);
    expect(creneaux.map((c) => c.start)).toEqual([
      '2026-03-29T00:00:00.000Z', '2026-03-29T00:30:00.000Z', '2026-03-29T01:00:00.000Z', '2026-03-29T01:30:00.000Z'
    ]);
  });

  test('nuit du retour à l’heure d’hiver : 02:00–03:00 passe deux fois, la plage dure 4 h', () => {
    const creneaux = computeSlots({
      resources: [paris({ sunday: [['01:00', '04:00']] })],
      service: { duration: 30 },
      from: '2026-10-24T00:00:00Z', to: '2026-10-26T00:00:00Z', now: '2026-10-01T00:00:00Z'
    });
    expect(creneaux.map((c) => `${c.local.time}${c.local.offset}`)).toEqual([
      '01:00+02:00', '01:30+02:00', '02:00+02:00', '02:30+02:00', '02:00+01:00', '02:30+01:00', '03:00+01:00', '03:30+01:00'
    ]);
  });

  test('heure murale inexistante ou ambiguë : tranchée comme Temporal', () => {
    expect(wallTimeToISO('2026-03-29', '02:30', 'Europe/Paris')).toBe('2026-03-29T01:30:00.000Z'); // → 03:30
    expect(wallTimeToISO('2026-10-25', '02:30', 'Europe/Paris')).toBe('2026-10-25T00:30:00.000Z'); // la première
    expect(wallTimeToISO('2026-07-01', '09:00', 'Africa/Lubumbashi')).toBe('2026-07-01T07:00:00.000Z');
  });

  test('Kinshasa et Lubumbashi ensemble (mode all) : seules les heures communes', () => {
    const lubumbashi = { id: 'salle-lubum', timeZone: 'Africa/Lubumbashi', weekly: { monday: [['09:00', '12:00']] } };
    const kinshasa = { id: 'expert-kin', timeZone: 'Africa/Kinshasa', weekly: { monday: [['09:00', '12:00']] } };
    const creneaux = computeSlots({
      resources: [kinshasa, lubumbashi],
      service: { duration: 60 },
      from: '2026-06-29T00:00:00Z', to: '2026-06-30T00:00:00Z', now: '2026-06-01T00:00:00Z',
      mode: 'all',
      timeZone: 'Africa/Lubumbashi'
    });
    // Kinshasa 09–12 = 08–11 UTC ; Lubumbashi 09–12 = 07–10 UTC → commun 08–10 UTC.
    expect(creneaux.map((c) => [c.start, c.local.time])).toEqual([
      ['2026-06-29T08:00:00.000Z', '10:00'],
      ['2026-06-29T09:00:00.000Z', '11:00']
    ]);
    expect(creneaux[0].resourceIds).toEqual(['expert-kin', 'salle-lubum']);
  });
});

describe('capacité et modes', () => {
  const salle = { id: 'salle', timeZone: 'Africa/Kinshasa', capacity: 3, weekly: { monday: [['09:00', '10:00']] } };
  const fenetre = { from: '2026-06-29T00:00:00Z', to: '2026-06-30T00:00:00Z', now: '2026-06-01T00:00:00Z' };
  const rdv = (seats) => ({ id: `r${seats}`, resourceIds: ['salle'], start: '2026-06-29T08:00:00Z', end: '2026-06-29T09:00:00Z', seats, status: 'confirmed' });

  test('places restantes, et créneau retiré quand il n’en reste plus assez', () => {
    const service = { duration: 60 };
    expect(computeSlots({ resources: [salle], service, ...fenetre, bookings: [rdv(1)] })[0].available).toBe(2);
    expect(computeSlots({ resources: [salle], service, ...fenetre, bookings: [rdv(1)], seats: 3 })).toEqual([]);
    expect(computeSlots({ resources: [salle], service, ...fenetre, bookings: [rdv(3)] })).toEqual([]);
  });

  test('mode any : un créneau par heure avec toutes les ressources libres', () => {
    const b1 = { id: 'b1', timeZone: 'Africa/Kinshasa', weekly: { monday: [['09:00', '11:00']] } };
    const b2 = { id: 'b2', timeZone: 'Africa/Kinshasa', weekly: { monday: [['10:00', '12:00']] } };
    const creneaux = computeSlots({ resources: [b1, b2], service: { duration: 60 }, ...fenetre, mode: 'any' });
    expect(creneaux.map((c) => [c.local.time, c.resourceIds, c.available])).toEqual([
      ['09:00', ['b1'], 1],
      ['10:00', ['b1', 'b2'], 2],
      ['11:00', ['b2'], 1]
    ]);
  });
});

describe('entrées refusées', () => {
  test('fuseau inconnu, heure invalide, jour inconnu, période avec horaires', () => {
    const base = { from: SEMAINE.from, to: SEMAINE.to, service: { duration: 30 } };
    expect(() => computeSlots({ ...base, resources: [{ id: 'x', timeZone: 'Mars/Olympus' }] })).toThrow(RangeError);
    expect(() => computeSlots({ ...base, resources: [{ id: 'x', timeZone: 'UTC', weekly: { monday: [['9h', '12h']] } }] })).toThrow(TypeError);
    expect(() => computeSlots({ ...base, resources: [{ id: 'x', timeZone: 'UTC', weekly: { lundi: [] } }] })).toThrow(/Jour inconnu/);
    expect(() => computeSlots({ ...base, resources: [{ id: 'x', timeZone: 'UTC', exceptions: [{ from: '2026-07-01', to: '2026-07-10', intervals: [['09:00', '10:00']] }] }] })).toThrow(TypeError);
    expect(() => computeSlots({ ...base, resources: [barbier], service: { duration: 0 } })).toThrow(TypeError);
  });
});
