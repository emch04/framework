import { createMonthlyPass, createStampCard, REWARD_STATUSES } from './src';
import type { MonthlyPassState, RewardStatus, ScanDecision, StampCardState } from './src';

const card = createStampCard({ threshold: 7, window: { months: 3, days: 15 } });
const end: string = card.cycleEnd('2026-01-01');
const state: StampCardState = card.evaluate({
  visits: [{ id: 'v1', date: '2026-01-01' }, { id: 'v2', date: '2026-01-05', redeemed: true }],
  reward: { status: 'used', visitId: 'v2', cycleStart: '2025-10-01' }
});
const free: boolean = card.isRewardAvailable({ status: 'available' });
const statuses: RewardStatus[] = REWARD_STATUSES;

const pass = createMonthlyPass({ quota: 5, timeZone: 'Europe/Paris', qrPrefix: 'BCA:', number: { prefix: 'A' } });
const month: MonthlyPassState = pass.evaluate({ status: 'active', uses: [{ date: '2026-09-03T10:00:00Z' }] });
const decision: ScanDecision = pass.decideScan({ status: 'active', uses: [] }, new Date(), { force: true });
const numero: string | null = pass.parseNumber('a901');

export { end, state, free, statuses, month, decision, numero };
