import { createStampCard, REWARD_STATUSES } from './src';
import type { StampCardState, RewardStatus } from './src';

const card = createStampCard({ threshold: 7, window: { months: 3, days: 15 } });
const end: string = card.cycleEnd('2026-01-01');
const state: StampCardState = card.evaluate({
  visits: [{ id: 'v1', date: '2026-01-01' }, { id: 'v2', date: '2026-01-05', redeemed: true }],
  reward: { status: 'used', visitId: 'v2', cycleStart: '2025-10-01' }
});
const free: boolean = card.isRewardAvailable({ status: 'available' });
const statuses: RewardStatus[] = REWARD_STATUSES;

export { end, state, free, statuses };
