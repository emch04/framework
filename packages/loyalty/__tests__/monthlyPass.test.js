/**
 * La carte à quota mensuel (extraite de Barber Clean, 23/09/2026) : N
 * passages par mois calendaire du fuseau du commerce, remise à zéro le 1er,
 * rien ne se reporte, au-delà le passage se paie.
 */
const { createMonthlyPass, SCAN_DECISIONS } = require('../src');

const carte = createMonthlyPass({ quota: 5, timeZone: 'Europe/Paris', qrPrefix: 'BCA:', number: { prefix: 'A', digits: 6 } });
const pass = (uses = [], status = 'active') => ({ status, uses });
const use = (date, cancelled = false) => ({ date: new Date(date), cancelled });

test('le quota entier au départ', () => {
  expect(carte.evaluate(pass(), '2026-09-10T10:00:00Z')).toEqual({
    month: '2026-09', used: 0, remaining: 5, quota: 5, exhausted: false, active: true, resetsOn: '2026-10-01', recentUses: []
  });
});

test('le mois est celui du fuseau du commerce, pas celui du serveur', () => {
  // 21 h 30 UTC le 30/09 = 23 h 30 à Paris : encore septembre.
  expect(carte.monthOf('2026-09-30T21:30:00Z')).toBe('2026-09');
  // 22 h 30 UTC = 0 h 30 le 1er octobre à Paris.
  expect(carte.monthOf('2026-09-30T22:30:00Z')).toBe('2026-10');
  const newYork = createMonthlyPass({ quota: 5, timeZone: 'America/New_York' });
  expect(newYork.monthOf('2026-10-01T02:00:00Z')).toBe('2026-09');
});

test('le 1er, tout revient au quota ; rien ne se reporte', () => {
  const p = pass([use('2026-09-03T10:00:00Z'), use('2026-09-20T10:00:00Z')]);
  expect(carte.evaluate(p, '2026-09-25T10:00:00Z').remaining).toBe(3);
  expect(carte.evaluate(p, '2026-10-01T08:00:00Z').remaining).toBe(5);
});

test('la remise à zéro tombe le 1er du mois suivant, décembre compris', () => {
  expect(carte.resetsOn('2026-09')).toBe('2026-10-01');
  expect(carte.resetsOn('2026-12')).toBe('2027-01-01');
});

test('un passage annulé rend le crédit', () => {
  const p = pass([use('2026-09-03T10:00:00Z'), use('2026-09-04T10:00:00Z', true)]);
  expect(carte.evaluate(p, '2026-09-10T10:00:00Z').used).toBe(1);
});

test('au-delà du quota, le scan ne compte plus', () => {
  const p = pass([1, 2, 3, 4, 5, 6].map((j) => use(`2026-09-0${j}T10:00:00Z`)));
  expect(carte.evaluate(p, '2026-09-20T10:00:00Z')).toMatchObject({ used: 5, remaining: 0, exhausted: true });
  expect(carte.decideScan(p, '2026-09-20T10:00:00Z')).toBe('exhausted');
});

test('deux scans rapprochés : le second demande confirmation, puis compte si forcé', () => {
  const p = pass([use('2026-09-10T10:00:00Z')]);
  expect(carte.decideScan(p, '2026-09-10T10:01:00Z')).toBe('duplicate');
  expect(carte.decideScan(p, '2026-09-10T10:01:00Z', { force: true })).toBe('count');
  expect(carte.decideScan(p, '2026-09-10T10:03:00Z')).toBe('count');
  // Un passage annulé ne déclenche pas la garde.
  expect(carte.decideScan(pass([use('2026-09-10T10:00:00Z', true)]), '2026-09-10T10:01:00Z')).toBe('count');
  const sansGarde = createMonthlyPass({ quota: 5, timeZone: 'Europe/Paris', duplicateWindowMs: 0 });
  expect(sansGarde.decideScan(p, '2026-09-10T10:00:10Z')).toBe('count');
});

test('une carte qui n’est pas active ne compte rien', () => {
  expect(carte.decideScan(pass([], 'suspended'), '2026-09-10T10:00:00Z')).toBe('suspended');
  expect(carte.decideScan(null)).toBe('suspended');
  expect(SCAN_DECISIONS).toEqual(['count', 'duplicate', 'exhausted', 'suspended']);
});

test('les trois derniers passages valides, du plus récent au plus ancien', () => {
  const p = pass([use('2026-08-30T10:00:00Z'), use('2026-09-02T10:00:00Z'), use('2026-09-05T10:00:00Z', true),
    use('2026-09-01T10:00:00Z'), use('2026-09-03T10:00:00Z')]);
  expect(carte.evaluate(p, '2026-09-10T10:00:00Z').recentUses).toEqual([
    '2026-09-03T10:00:00.000Z', '2026-09-02T10:00:00.000Z', '2026-09-01T10:00:00.000Z'
  ]);
});

test('le QR porte le jeton, reconnaissable, et refuse tout le reste', () => {
  const jeton = 'abcdefghijklmnopqrstuvwxyz012345';
  expect(carte.tokenFromQr(carte.qrText(jeton))).toBe(jeton);
  expect(carte.tokenFromQr(`  ${carte.qrText(jeton)} `)).toBe(jeton);
  for (const texte of ['Fidélité BC-000123', 'https://exemple.com', 'BCA:court', 'BCA:../../etc', '', null]) {
    expect(carte.tokenFromQr(texte)).toBeNull();
  }
});

test('le numéro tapé à la main est reconnu quelle que soit l’écriture', () => {
  for (const saisie of ['A-000901', 'a-000901', 'A000901', ' a 000901 ', 'a901', '901', 'A-901']) {
    expect(carte.parseNumber(saisie)).toBe('A-000901');
  }
  for (const saisie of ['', 'BC-000901', 'B-000901', 'A-1234567', 'abc', '../etc', '0', 'A-000000']) {
    expect(carte.parseNumber(saisie)).toBeNull();
  }
  expect(carte.formatNumber(123)).toBe('A-000123');
  expect(() => carte.formatNumber(0)).toThrow(RangeError);
  expect(() => carte.formatNumber(1234567)).toThrow(RangeError);
});

test('les réglages invalides sont refusés dès la création', () => {
  expect(() => createMonthlyPass({ quota: 5 })).toThrow(/timeZone est obligatoire/);
  expect(() => createMonthlyPass({ quota: 5, timeZone: 'Mars/Olympus' })).toThrow(/inconnu/);
  expect(() => createMonthlyPass({ quota: 0, timeZone: 'UTC' })).toThrow(/quota/);
  expect(() => createMonthlyPass({ quota: 2.5, timeZone: 'UTC' })).toThrow(/quota/);
  expect(() => createMonthlyPass({ quota: 5, timeZone: 'UTC', duplicateWindowMs: -1 })).toThrow(/duplicateWindowMs/);
  expect(() => createMonthlyPass({ quota: 5, timeZone: 'UTC', number: { prefix: 'a-' } })).toThrow(/prefix/);
  const nue = createMonthlyPass({ quota: 5, timeZone: 'UTC' });
  expect(() => nue.qrText('x')).toThrow(/qrPrefix/);
  expect(() => nue.parseNumber('1')).toThrow(/number/);
});
