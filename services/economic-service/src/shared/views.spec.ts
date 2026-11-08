import { storedTransactionDetailView, toRewardBalanceView, toRewardRuleView } from './views';
import type { TransactionDetailView } from '../transaction/dto';

/**
 * The view mappers, at the points where they decide rather than copy.
 *
 * Most of this file is field-for-field translation and reads as such. The
 * branches are the interesting part, and each one is a distinction the API
 * makes deliberately: a level that exists against one that does not, and an
 * amount that crosses the wire as a string rather than a number (ADR-022).
 */
describe('toRewardRuleView', () => {
  const row = {
    id: 'RWR_1',
    organizationId: null,
    triggerEvent: 'USAGE_RECORDED',
    rewardType: 'POINTS',
    condition: null,
    points: 2,
    creditPerPointMinor: 9_007_199_254_740_993n,
    periodCap: 40,
    periodType: 'DAY',
    validFrom: new Date('2026-10-29T00:00:00.000Z'),
    validTo: null,
    status: 'ACTIVE',
    label: null,
    createdAt: new Date('2026-10-29T00:00:00.000Z'),
    createdBy: 'USR-1',
    updatedAt: new Date('2026-10-29T00:00:00.000Z'),
    updatedBy: 'USR-1',
  };

  it('answers the credit as an exact decimal string, and the points cap as a number', () => {
    // 2^53 + 1: `Number(...)` would have answered …992 (economic audit F1).
    const view = toRewardRuleView(row);
    expect(view.creditPerPointMinor).toBe('9007199254740993');
    expect(view.periodCap).toBe(40);
    expect(Object.values(view).some((value) => typeof value === 'bigint')).toBe(false);
  });

  it('keeps a points-only rule’s credit null, not "0"', () => {
    expect(toRewardRuleView({ ...row, creditPerPointMinor: null }).creditPerPointMinor).toBeNull();
  });
});

describe('toRewardBalanceView', () => {
  const base = {
    organizationId: 'ORG-A',
    userId: 'USR-1',
    totalPoints: 40,
    lifetimeCreditMinor: 125_000n,
    updatedAt: new Date('2026-08-29T10:00:00.000Z'),
  };

  it('reports null for a level ladder nobody has configured', () => {
    // docs/24 Q-13 is open: levels are computed but grant no benefit, and no
    // ladder is configured on this platform. `null` says that; a fabricated
    // "level 0" would claim a standing the user does not have.
    const view = toRewardBalanceView({ ...base, level: null });

    expect(view.level).toBeNull();
    expect(view.totalPoints).toBe(40);
  });

  it('reports the level a subject has reached, with its rank and threshold', () => {
    const view = toRewardBalanceView({
      ...base,
      level: { id: 'RWL_1', name: 'نقره‌ای', rank: 1, minPoints: 25 },
    });

    // The threshold travels with the level so a client can render progress
    // without a second call, and the rank so it can order levels it has never
    // seen before.
    expect(view.level).toEqual({ id: 'RWL_1', name: 'نقره‌ای', rank: 1, minPoints: 25 });
  });

  it('sends the lifetime credit as a string in minor units', () => {
    // A rial figure past Number.MAX_SAFE_INTEGER is truncated by the client's
    // own JSON parser, where no validation of ours can see it (ADR-022).
    const view = toRewardBalanceView({
      ...base,
      level: null,
      lifetimeCreditMinor: 9_007_199_254_740_993n,
    });

    expect(view.lifetimeCreditMinor).toBe('9007199254740993');
    expect(typeof view.lifetimeCreditMinor).toBe('string');
  });

  it('sends the timestamp as UTC ISO-8601', () => {
    // Storage is UTC throughout; conversion to the Hijri calendar happens in
    // the presentation layer and nowhere else (AGENTS.md § 3).
    expect(toRewardBalanceView({ ...base, level: null }).updatedAt).toBe(
      '2026-08-29T10:00:00.000Z',
    );
  });
});

/**
 * A transaction command's stored answer, replayed (Codex on #352, finding 2):
 * one the previous release stored has no `resolvedDisputeId`, which this
 * release documents as required.
 */
describe('storedTransactionDetailView', () => {
  const stored = { id: 'TXN_STORED', disputeId: 'TXD_A' } as unknown as TransactionDetailView;

  it('gives an answer stored before the field an explicit null: not attributed by identity', () => {
    expect(storedTransactionDetailView(stored)).toEqual({
      id: 'TXN_STORED',
      disputeId: 'TXD_A',
      resolvedDisputeId: null,
    });
  });

  it('replays an answer that has it as stored, null or not', () => {
    for (const resolvedDisputeId of ['TXD_A', null]) {
      const answer = { ...stored, resolvedDisputeId };
      expect(storedTransactionDetailView(answer)).toBe(answer);
    }
  });
});
