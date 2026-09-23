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

export type ScanDecision = 'count' | 'duplicate' | 'exhausted' | 'suspended';

export interface MonthlyPassUse {
  date: Date | string | number;
  /** A cancelled use gives the credit back. */
  cancelled?: boolean;
}

export interface MonthlyPassData {
  status?: 'active' | string;
  uses?: MonthlyPassUse[];
}

export interface MonthlyPassState {
  /** Month in the business time zone, AAAA-MM. */
  month: string;
  used: number;
  remaining: number;
  quota: number;
  exhausted: boolean;
  active: boolean;
  /** First day of next month, AAAA-MM-JJ. */
  resetsOn: string;
  /** Last three valid uses, any month, newest first (ISO). */
  recentUses: string[];
}

export interface MonthlyPassOptions {
  quota: number;
  /** IANA time zone of the business, e.g. 'Europe/Paris'. Required. */
  timeZone: string;
  /** Two uses closer than this ask for confirmation. 0 disables. Default 120000. */
  duplicateWindowMs?: number;
  /** QR text prefix, e.g. 'BCA:'. Needed for qrText / tokenFromQr. */
  qrPrefix?: string;
  /** Readable card number, e.g. { prefix: 'A', digits: 6 } → A-000123. */
  number?: { prefix: string; digits?: number };
}

export interface MonthlyPass {
  quota: number;
  timeZone: string;
  monthOf(date: Date | string | number): string;
  resetsOn(month: string): string;
  evaluate(pass: MonthlyPassData | null | undefined, now?: Date | string | number): MonthlyPassState;
  decideScan(pass: MonthlyPassData | null | undefined, now?: Date | string | number, options?: { force?: boolean }): ScanDecision;
  qrText(token: string): string;
  tokenFromQr(text: string): string | null;
  formatNumber(n: number): string;
  parseNumber(input: string): string | null;
}

export function createMonthlyPass(options: MonthlyPassOptions): MonthlyPass;
export const SCAN_DECISIONS: readonly ScanDecision[];
