'use strict';

const { createSrs, createSrsParams, createMemorySrsStore, parseGrade } = require('../src');

const MIN = 60_000;
const DAY = 86_400_000;

function setup(options = {}) {
  let t = new Date('2026-03-02T08:00:00.000Z').getTime();
  const clock = { now: () => new Date(t) };
  const srs = createSrs({ clock, ...options });
  return { srs, advance: (ms) => { t += ms; }, clock };
}

describe('paramètres FSRS', () => {
  test('valeurs par défaut et surcharges', () => {
    expect(createSrsParams().request_retention).toBe(0.9);
    expect(createSrsParams({ request_retention: 0.95 }).request_retention).toBe(0.95);
  });
  test('refuse une rétention ou des poids incohérents', () => {
    expect(() => createSrsParams({ request_retention: 0 })).toThrow('INVALID_REQUEST_RETENTION');
    expect(() => createSrsParams({ request_retention: 1.5 })).toThrow('INVALID_REQUEST_RETENTION');
    expect(() => createSrsParams({ w: [1, 2, 3] })).toThrow('INVALID_FSRS_WEIGHTS');
    expect(() => createSrsParams({ maximum_interval: 0 })).toThrow('INVALID_MAXIMUM_INTERVAL');
  });
  test('une rétention plus haute donne des intervalles plus courts', async () => {
    const intervals = [];
    for (const retention of [0.8, 0.97]) {
      const { srs, advance } = setup({ params: { request_retention: retention, enable_short_term: false } });
      const card = await srs.addCard({ front: 'a', back: 'b' });
      let result = await srs.review(card.id, 'good');
      advance(result.intervalMs);
      result = await srs.review(card.id, 'good');
      advance(result.intervalMs);
      result = await srs.review(card.id, 'good');
      intervals.push(result.intervalMs);
    }
    expect(intervals[0]).toBeGreaterThan(intervals[1]);
  });
});

describe('notes', () => {
  test('accepte les noms et les nombres, refuse le reste', () => {
    expect(parseGrade('Again')).toBe(1);
    expect(parseGrade('easy')).toBe(4);
    expect(parseGrade(3)).toBe(3);
    expect(() => parseGrade('super')).toThrow('INVALID_GRADE');
    expect(() => parseGrade(5)).toThrow('INVALID_GRADE');
  });
});

describe('cartes et révision', () => {
  test('une carte neuve est due et passe en apprentissage après une note', async () => {
    const { srs } = setup();
    const card = await srs.addCard({ deckId: 'es', front: 'hola', back: 'bonjour' });
    expect(card.stateName).toBe('new');
    const { card: next, nextDue } = await srs.review(card.id, 'good');
    expect(next.stateName).toBe('learning');
    expect(new Date(nextDue).getTime()).toBe(new Date('2026-03-02T08:10:00.000Z').getTime());
  });

  test('Easy fait sauter l’apprentissage, Again le garde court, l’ordre des échéances est croissant', async () => {
    const { srs } = setup();
    const card = await srs.addCard({ front: 'a', back: 'b' });
    const p = await srs.preview(card.id);
    expect(p.again.intervalMs).toBeLessThan(p.good.intervalMs);
    expect(p.good.intervalMs).toBeLessThan(p.easy.intervalMs);
    const easy = await srs.review(card.id, 'easy');
    expect(easy.card.stateName).toBe('review');
    expect(easy.intervalMs).toBeGreaterThanOrEqual(DAY);
  });

  test('preview n’enregistre rien', async () => {
    const { srs } = setup();
    const card = await srs.addCard({ front: 'a', back: 'b' });
    await srs.preview(card.id);
    expect((await srs.getCard(card.id)).schedule.reps).toBe(0);
    expect((await srs.stats()).totalReviews).toBe(0);
  });

  test('un oubli en révision incrémente les lapses et passe en réapprentissage', async () => {
    const { srs, advance } = setup();
    const card = await srs.addCard({ front: 'a', back: 'b' });
    const first = await srs.review(card.id, 'easy');
    advance(first.intervalMs);
    const lapse = await srs.review(card.id, 'again');
    expect(lapse.card.stateName).toBe('relearning');
    expect(lapse.card.schedule.lapses).toBe(1);
  });

  test('les intervalles grandissent quand on répond bien', async () => {
    const { srs, advance } = setup();
    const card = await srs.addCard({ front: 'a', back: 'b' });
    let result = await srs.review(card.id, 'easy');
    const seen = [result.intervalMs];
    for (let i = 0; i < 3; i += 1) {
      advance(result.intervalMs);
      result = await srs.review(card.id, 'good');
      seen.push(result.intervalMs);
    }
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(seen[3]).toBeGreaterThan(seen[2]);
  });

  test('erreurs propres : introuvable, doublon, texte vide, suspendue', async () => {
    const { srs } = setup();
    await expect(srs.review('nope', 'good')).rejects.toMatchObject({ code: 'CARD_NOT_FOUND' });
    await srs.addCard({ id: 'c1', front: 'a', back: 'b' });
    await expect(srs.addCard({ id: 'c1', front: 'a', back: 'b' })).rejects.toMatchObject({ code: 'CARD_EXISTS' });
    await expect(srs.addCard({ front: '', back: 'b' })).rejects.toThrow('FRONT_REQUIRED');
    await expect(srs.addCard({ front: 'a', back: ' ' })).rejects.toThrow('BACK_REQUIRED');
    await srs.suspend('c1');
    await expect(srs.review('c1', 'good')).rejects.toMatchObject({ code: 'CARD_SUSPENDED' });
    await srs.resume('c1');
    await expect(srs.review('c1', 'good')).resolves.toBeTruthy();
  });

  test('le stockage reçoit des copies sérialisables (dates en ISO)', async () => {
    const store = createMemorySrsStore();
    const { srs } = setup({ store });
    const card = await srs.addCard({ id: 'c', front: 'a', back: 'b' });
    await srs.review(card.id, 'good');
    const raw = await store.get('c');
    expect(typeof raw.schedule.due).toBe('string');
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
  });
});

describe('file du jour', () => {
  test('ordre : apprentissage échu, révisions échues, puis nouvelles', async () => {
    const { srs, advance } = setup();
    const rev = await srs.addCard({ id: 'rev', front: 'r', back: 'r' });
    const lrn = await srs.addCard({ id: 'lrn', front: 'l', back: 'l' });
    const r = await srs.review(rev.id, 'easy');
    await srs.review(lrn.id, 'good');
    await srs.addCard({ id: 'new', front: 'n', back: 'n' });
    advance(r.intervalMs + MIN);
    const queue = await srs.dueQueue();
    expect(queue.map((c) => c.id)).toEqual(['lrn', 'rev', 'new']);
  });

  test('une carte pas encore échue n’y figure pas', async () => {
    const { srs } = setup();
    const c = await srs.addCard({ front: 'a', back: 'b' });
    await srs.review(c.id, 'easy');
    expect(await srs.dueQueue()).toEqual([]);
  });

  test('quota de nouvelles cartes par jour, entamé par les cartes déjà vues', async () => {
    const { srs, advance } = setup({ newCardsPerDay: 2 });
    for (const id of ['a', 'b', 'c', 'd']) await srs.addCard({ id, front: id, back: id });
    expect((await srs.dueQueue()).map((c) => c.id)).toEqual(['a', 'b']);
    await srs.review('a', 'easy');
    // une nouvelle carte vue aujourd'hui : il en reste une seule au quota
    expect((await srs.dueQueue()).map((c) => c.id)).toEqual(['b']);
    advance(DAY);
    expect((await srs.dueQueue()).map((c) => c.id)).toEqual(expect.arrayContaining(['b', 'c']));
  });

  test('plafond de révisions par jour et limite explicite', async () => {
    const { srs, advance } = setup({ maxReviewsPerDay: 2, newCardsPerDay: 10 });
    const ids = ['a', 'b', 'c', 'd'];
    let interval = 0;
    for (const id of ids) { await srs.addCard({ id, front: id, back: id }); interval = (await srs.review(id, 'easy')).intervalMs; }
    advance(interval + DAY);
    expect(await srs.dueQueue()).toHaveLength(2);
    expect(await srs.dueQueue({ limit: 1 })).toHaveLength(1);
  });

  test('filtre par paquet et exclut les cartes suspendues', async () => {
    const { srs } = setup();
    await srs.addCard({ id: 'a', deckId: 'es', front: 'a', back: 'a' });
    await srs.addCard({ id: 'b', deckId: 'ja', front: 'b', back: 'b' });
    await srs.addCard({ id: 'c', deckId: 'es', front: 'c', back: 'c' });
    await srs.suspend('c');
    expect((await srs.dueQueue({ deckId: 'es' })).map((x) => x.id)).toEqual(['a']);
  });

  test('le jour de l’apprenant suit son décalage horaire', async () => {
    // 23:30 UTC = 00:30 le lendemain à UTC+1 : le quota se renouvelle déjà.
    const t = { v: new Date('2026-03-02T22:30:00.000Z').getTime() };
    const srs = createSrs({ clock: { now: () => new Date(t.v) }, newCardsPerDay: 1, dayOffsetMinutes: 60 });
    await srs.addCard({ id: 'a', front: 'a', back: 'a' });
    await srs.addCard({ id: 'b', front: 'b', back: 'b' });
    await srs.review('a', 'good');
    expect((await srs.dueQueue()).map((c) => c.id)).toEqual([]);
    t.v += 60 * MIN;
    // « a » est en apprentissage et échue ; « b » est neuve et le quota du nouveau jour est libre.
    expect((await srs.dueQueue()).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('statistiques', () => {
  test('comptes par état, échues, révisions du jour, rétention réelle', async () => {
    const { srs, advance } = setup();
    for (const id of ['a', 'b', 'c']) await srs.addCard({ id, front: id, back: id });
    const a = await srs.review('a', 'easy');
    const b = await srs.review('b', 'easy');
    await srs.suspend('c');
    advance(a.intervalMs + DAY);
    await srs.review('a', 'good');
    await srs.review('b', 'again');
    const s = await srs.stats();
    expect(s).toMatchObject({ total: 3, suspended: 1, review: 1, relearning: 1, totalReviews: 4, reviewsToday: 2, targetRetention: 0.9 });
    expect(s.trueRetention).toBe(0.5);
    expect(b).toBeTruthy();
  });

  test('rétention nulle sans révision, et filtre par paquet', async () => {
    const { srs } = setup();
    await srs.addCard({ deckId: 'es', front: 'a', back: 'a' });
    await srs.addCard({ deckId: 'ja', front: 'b', back: 'b' });
    const s = await srs.stats({ deckId: 'es' });
    expect(s.total).toBe(1);
    expect(s.trueRetention).toBeNull();
  });
});
