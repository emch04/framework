'use strict';

const crypto = require('node:crypto');
const { fsrs, createEmptyCard, State } = require('ts-fsrs');
const { createSrsParams } = require('./params');
const { createMemorySrsStore } = require('./store');
const { GRADE_NAMES, GRADES, STATE_NAMES, parseGrade } = require('./grades');

const DAY_MS = 86_400_000;
const MATURE_STABILITY_DAYS = 21;

function toSchedule(card) {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ? card.last_review.toISOString() : null
  };
}

function fromSchedule(schedule) {
  return {
    due: new Date(schedule.due),
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsed_days: schedule.elapsedDays,
    scheduled_days: schedule.scheduledDays,
    learning_steps: schedule.learningSteps,
    reps: schedule.reps,
    lapses: schedule.lapses,
    state: schedule.state,
    last_review: schedule.lastReview ? new Date(schedule.lastReview) : undefined
  };
}

function view(record) {
  return { ...record, stateName: STATE_NAMES[record.schedule.state] };
}

/**
 * Le « jour » d'un apprenant ne commence pas à minuit UTC : `dayOffsetMinutes`
 * est son décalage (ex. 60 pour Kinshasa, UTC+1) et sert à compter les cartes
 * nouvelles et les révisions « du jour ».
 */
function dayStart(now, dayOffsetMinutes) {
  const shifted = now.getTime() + dayOffsetMinutes * 60_000;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - dayOffsetMinutes * 60_000);
}

function createSrs({
  store = createMemorySrsStore(),
  params = {},
  clock = { now: () => new Date() },
  newCardsPerDay = 20,
  maxReviewsPerDay = 200,
  dayOffsetMinutes = 0,
  idGenerator = () => crypto.randomUUID()
} = {}) {
  if (!Number.isInteger(newCardsPerDay) || newCardsPerDay < 0) throw new RangeError('INVALID_NEW_CARDS_PER_DAY');
  if (!Number.isInteger(maxReviewsPerDay) || maxReviewsPerDay < 0) throw new RangeError('INVALID_MAX_REVIEWS_PER_DAY');
  const fsrsParams = createSrsParams(params);
  const scheduler = fsrs(fsrsParams);
  const now = () => new Date(clock.now());

  async function load(id) {
    const record = await store.get(id);
    if (!record) throw Object.assign(new Error('CARD_NOT_FOUND'), { code: 'CARD_NOT_FOUND' });
    return record;
  }

  async function addCard({ id, deckId = 'default', front, back, data } = {}) {
    if (typeof front !== 'string' || !front.trim()) throw new TypeError('FRONT_REQUIRED');
    if (typeof back !== 'string' || !back.trim()) throw new TypeError('BACK_REQUIRED');
    const cardId = id ?? idGenerator();
    if (await store.get(cardId)) throw Object.assign(new Error('CARD_EXISTS'), { code: 'CARD_EXISTS' });
    const at = now();
    const record = {
      id: cardId,
      deckId,
      front,
      back,
      data: data ?? null,
      suspended: false,
      createdAt: at.toISOString(),
      schedule: toSchedule(createEmptyCard(at))
    };
    await store.put(record);
    return view(record);
  }

  /** Les quatre échéances possibles, sans rien enregistrer (boutons « 10 min / 1 j / 3 j / 8 j »). */
  async function preview(id) {
    const record = await load(id);
    const at = now();
    const options = scheduler.repeat(fromSchedule(record.schedule), at);
    const out = {};
    for (const name of GRADE_NAMES) {
      const next = options[GRADES[name]].card;
      out[name] = { due: next.due.toISOString(), intervalMs: next.due.getTime() - at.getTime() };
    }
    return out;
  }

  async function review(id, grade) {
    const rating = parseGrade(grade);
    const record = await load(id);
    if (record.suspended) throw Object.assign(new Error('CARD_SUSPENDED'), { code: 'CARD_SUSPENDED' });
    const at = now();
    const before = record.schedule;
    const result = scheduler.next(fromSchedule(before), at, rating);
    record.schedule = toSchedule(result.card);
    await store.put(record);
    const log = {
      cardId: id,
      deckId: record.deckId,
      grade: rating,
      stateBefore: before.state,
      stateAfter: record.schedule.state,
      reviewedAt: at.toISOString(),
      due: record.schedule.due,
      scheduledDays: record.schedule.scheduledDays,
      stability: record.schedule.stability,
      difficulty: record.schedule.difficulty
    };
    await store.addLog(log);
    return { card: view(record), nextDue: record.schedule.due, intervalMs: result.card.due.getTime() - at.getTime(), log };
  }

  /**
   * File du jour : d'abord ce qui est en (ré)apprentissage et déjà échu, puis
   * les révisions échues (les plus en retard d'abord, plafonnées), puis les
   * cartes nouvelles dans la limite du quota quotidien — déjà entamé si des
   * cartes ont été vues aujourd'hui.
   */
  async function dueQueue({ deckId, limit } = {}) {
    const at = now();
    const cards = (await store.list({ deckId })).filter((card) => !card.suspended);
    const due = (card) => new Date(card.schedule.due) <= at;
    const byDue = (a, b) => new Date(a.schedule.due) - new Date(b.schedule.due);

    const learning = cards.filter((c) => (c.schedule.state === State.Learning || c.schedule.state === State.Relearning) && due(c)).sort(byDue);

    const start = dayStart(at, dayOffsetMinutes).toISOString();
    const logsToday = await store.listLogs({ deckId, since: start });
    const reviewsDone = logsToday.filter((l) => l.stateBefore === State.Review).length;
    const newDone = new Set(logsToday.filter((l) => l.stateBefore === State.New).map((l) => l.cardId)).size;

    const reviews = cards.filter((c) => c.schedule.state === State.Review && due(c)).sort(byDue).slice(0, Math.max(0, maxReviewsPerDay - reviewsDone));
    const fresh = cards.filter((c) => c.schedule.state === State.New).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, Math.max(0, newCardsPerDay - newDone));

    const queue = [...learning, ...reviews, ...fresh].map(view);
    return limit === undefined ? queue : queue.slice(0, limit);
  }

  async function stats({ deckId } = {}) {
    const at = now();
    const cards = await store.list({ deckId });
    const counts = { total: cards.length, new: 0, learning: 0, review: 0, relearning: 0, suspended: 0, mature: 0 };
    let dueNow = 0;
    for (const card of cards) {
      if (card.suspended) { counts.suspended += 1; continue; }
      counts[STATE_NAMES[card.schedule.state]] += 1;
      if (card.schedule.state !== State.New && new Date(card.schedule.due) <= at) dueNow += 1;
      if (card.schedule.state === State.Review && card.schedule.stability >= MATURE_STABILITY_DAYS) counts.mature += 1;
    }
    const logs = await store.listLogs({ deckId });
    const todayStart = dayStart(at, dayOffsetMinutes).toISOString();
    const reviewsToday = logs.filter((l) => l.reviewedAt >= todayStart).length;
    // Rétention réelle : parmi les cartes déjà en révision, part des réponses autres que « Again ».
    const matureLogs = logs.filter((l) => l.stateBefore === State.Review);
    const trueRetention = matureLogs.length ? matureLogs.filter((l) => l.grade > 1).length / matureLogs.length : null;
    return { ...counts, dueNow, reviewsToday, totalReviews: logs.length, trueRetention, targetRetention: fsrsParams.request_retention };
  }

  async function setSuspended(id, suspended) {
    const record = await load(id);
    record.suspended = Boolean(suspended);
    await store.put(record);
    return view(record);
  }

  return {
    params: fsrsParams,
    addCard,
    getCard: async (id) => view(await load(id)),
    removeCard: (id) => store.remove(id),
    preview,
    review,
    dueQueue,
    stats,
    suspend: (id) => setSuspended(id, true),
    resume: (id) => setSuspended(id, false)
  };
}

module.exports = { createSrs };
