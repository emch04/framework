export type GradeName = 'again' | 'hard' | 'good' | 'easy';
export type Grade = GradeName | 'Again' | 'Hard' | 'Good' | 'Easy' | 1 | 2 | 3 | 4;
export type CardStateName = 'new' | 'learning' | 'review' | 'relearning';

export const GRADES: Readonly<Record<GradeName, 1 | 2 | 3 | 4>>;
export const GRADE_NAMES: readonly GradeName[];
export function parseGrade(grade: Grade): 1 | 2 | 3 | 4;

/** Paramètres FSRS (voir ts-fsrs) : rétention visée, intervalle maximal, pas d'apprentissage, brouillage, poids. */
export interface SrsParams {
  request_retention?: number;
  maximum_interval?: number;
  w?: number[] | readonly number[];
  enable_fuzz?: boolean;
  enable_short_term?: boolean;
  learning_steps?: string[];
  relearning_steps?: string[];
}
export function createSrsParams(overrides?: SrsParams): Required<Pick<SrsParams, 'request_retention' | 'maximum_interval'>> & SrsParams;

export interface CardSchedule {
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  /** 0 nouveau, 1 apprentissage, 2 révision, 3 réapprentissage. */
  state: 0 | 1 | 2 | 3;
  lastReview: string | null;
}
export interface SrsCardRecord {
  id: string;
  deckId: string;
  front: string;
  back: string;
  data: unknown;
  suspended: boolean;
  createdAt: string;
  schedule: CardSchedule;
}
export interface SrsCard extends SrsCardRecord { stateName: CardStateName }
export interface ReviewLog {
  cardId: string;
  deckId: string;
  grade: 1 | 2 | 3 | 4;
  stateBefore: number;
  stateAfter: number;
  reviewedAt: string;
  due: string;
  scheduledDays: number;
  stability: number;
  difficulty: number;
}

type Awaitable<T> = T | Promise<T>;
export interface SrsStore {
  get(id: string): Awaitable<SrsCardRecord | null>;
  put(card: SrsCardRecord): Awaitable<void>;
  remove(id: string): Awaitable<boolean>;
  list(filter?: { deckId?: string }): Awaitable<SrsCardRecord[]>;
  addLog(entry: ReviewLog): Awaitable<void>;
  listLogs(filter?: { deckId?: string; since?: string }): Awaitable<ReviewLog[]>;
}
export function createMemorySrsStore(): SrsStore;

export interface SrsStats {
  total: number;
  new: number;
  learning: number;
  review: number;
  relearning: number;
  suspended: number;
  mature: number;
  dueNow: number;
  reviewsToday: number;
  totalReviews: number;
  trueRetention: number | null;
  targetRetention: number;
}

export interface Srs {
  params: SrsParams;
  addCard(card: { id?: string; deckId?: string; front: string; back: string; data?: unknown }): Promise<SrsCard>;
  getCard(id: string): Promise<SrsCard>;
  removeCard(id: string): Awaitable<boolean>;
  preview(id: string): Promise<Record<GradeName, { due: string; intervalMs: number }>>;
  review(id: string, grade: Grade): Promise<{ card: SrsCard; nextDue: string; intervalMs: number; log: ReviewLog }>;
  dueQueue(options?: { deckId?: string; limit?: number }): Promise<SrsCard[]>;
  stats(options?: { deckId?: string }): Promise<SrsStats>;
  suspend(id: string): Promise<SrsCard>;
  resume(id: string): Promise<SrsCard>;
}
export function createSrs(options?: {
  store?: SrsStore;
  params?: SrsParams;
  clock?: { now(): Date | number };
  newCardsPerDay?: number;
  maxReviewsPerDay?: number;
  /** Décalage horaire de l'apprenant en minutes (ex. 60 pour UTC+1). */
  dayOffsetMinutes?: number;
  idGenerator?: () => string;
}): Srs;
