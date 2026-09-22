export type RewardStatus = 'available' | 'reserved' | 'used' | 'lost';

export interface StampVisit {
  /** Calendar day, AAAA-MM-JJ. */
  date: string;
  id?: string;
  /** The visit where the reward was consumed: separates two cycles, earns no stamp. */
  redeemed?: boolean;
}

export interface StampReward {
  status?: RewardStatus;
  /** Start of the cycle the reward was granted for. */
  cycleStart?: string;
  /** Visit that consumed the reward, for data without `redeemed`. */
  visitId?: string;
}

export interface StampCardState {
  cycleStart: string | null;
  cycleEnd: string | null;
  count: number;
  remaining: number;
  reached: boolean;
  shouldGrant: boolean;
}

export interface StampCardOptions {
  threshold?: number;
  window?: { months?: number; days?: number };
}

export interface StampCard {
  threshold: number;
  cycleEnd(start: string): string;
  evaluate(input: { visits?: StampVisit[]; reward?: StampReward | null }): StampCardState;
  isRewardAvailable(reward?: StampReward | null): boolean;
}

export function createStampCard(options?: StampCardOptions): StampCard;
export const REWARD_STATUSES: RewardStatus[];
