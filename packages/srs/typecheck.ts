import { GRADES, GRADE_NAMES, createMemorySrsStore, createSrs, createSrsParams, parseGrade } from './src';
import type { Grade, Srs, SrsCard, SrsStats, SrsStore } from './src';

const store: SrsStore = createMemorySrsStore();
const srs: Srs = createSrs({
  store,
  params: createSrsParams({ request_retention: 0.92, maximum_interval: 365 }),
  clock: { now: () => new Date() },
  newCardsPerDay: 10,
  maxReviewsPerDay: 100,
  dayOffsetMinutes: 60
});

async function exercise(): Promise<void> {
  const card: SrsCard = await srs.addCard({ deckId: 'espagnol', front: 'hola', back: 'bonjour' });
  const grade: Grade = 'good';
  const done = await srs.review(card.id, grade);
  const due: string = done.nextDue;
  const options = await srs.preview(card.id);
  const goodDue: string = options.good.due;
  const queue: SrsCard[] = await srs.dueQueue({ deckId: 'espagnol', limit: 20 });
  const stats: SrsStats = await srs.stats();
  void [due, goodDue, queue, stats, GRADES.again, GRADE_NAMES, parseGrade(3)];
}
void exercise;
