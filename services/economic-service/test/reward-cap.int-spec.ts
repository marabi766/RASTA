import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { asActor, cleanup, newPrisma, readBalances, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Rewards, against a real database (docs/10 § 10.8, § 10.9, § 10.12, ADR-033).
 *
 * Two of docs/10 § 10.12's mandatory assertions live here:
 *
 * > سقف پاداش: `periodCap` هرگز نقض نمی‌شود، حتی با رویدادهای موازی
 *
 * — which no single-threaded test can establish, because the defect it guards
 * against is two triggers both reading "there is room" — and the ADR-033
 * property that a points-only rule posts **no journal at all**.
 */
describe('rewards (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();
  const user = `USR-ITEST-${ulid().slice(-8)}`;

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  async function createRule(overrides: Record<string, unknown>) {
    return asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
      wiring.rewards.createRule({
        organizationId: org.a,
        triggerEvent: 'USAGE_RECORDED',
        rewardType: 'POINTS',
        points: 10,
        status: 'ACTIVE',
        label: 'itest',
        ...overrides,
      } as never),
    );
  }

  function grant(sourceReference: string) {
    return asActor({ organizationId: org.a, userId: user }, () =>
      wiring.rewards.grantFor({
        organizationId: org.a,
        userId: user,
        triggerEvent: 'USAGE_RECORDED',
        sourceReference,
        occurredAt: new Date(),
        payload: { hours: '8' },
      }),
    );
  }

  describe('points only, unless a rate is configured', () => {
    it('grants points and posts no journal', async () => {
      // ADR-033, and the state every rule in this repository is in: docs/24
      // Q-09 is open, so no conversion rate exists and no money moves.
      await createRule({ points: 10 });

      const outcomes = await grant(`USG_${ulid()}`);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ kind: 'GRANTED', points: 10, monetised: false });

      const rewards = await asActor({ organizationId: org.a }, () =>
        prisma.client.reward.findMany({ where: { organizationId: org.a } }),
      );
      expect(rewards).toHaveLength(1);
      expect(rewards[0]?.creditAmountMinor).toBe(0n);
      expect(rewards[0]?.journalId).toBeNull();

      // And no journal, anywhere. A zero-amount entry would break
      // `ck_ledger_entry_amount_positive` and would assert nothing.
      const journals = await runUnscoped('the reward audit counts journals for the tenant', () =>
        prisma.client.journal.findMany({
          where: { organizationId: org.a, journalType: 'REWARD_GRANT' },
        }),
      );
      expect(journals).toEqual([]);

      await cleanup(prisma, [org.a]);
    });

    it('credits the wallet and posts a balanced journal when a rate is configured', async () => {
      // The monetised half, exactly as docs/10 § 10.4's third example: debit
      // the platform's reward expense, credit the organization's wallet.
      await createRule({ points: 10, creditPerPointMinor: '1000' });

      const outcomes = await grant(`USG_${ulid()}`);
      expect(outcomes[0]).toMatchObject({
        kind: 'GRANTED',
        points: 10,
        creditAmountMinor: 10_000n,
        monetised: true,
      });

      const wallet = await asActor({ organizationId: org.a }, () =>
        wiring.wallets.getOrOpen('IRR'),
      );
      expect((await readBalances(prisma, wallet.id)).available).toBe(10_000n);

      const journals = await runUnscoped('the reward audit counts journals for the tenant', () =>
        prisma.client.journal.findMany({
          where: { organizationId: org.a, journalType: 'REWARD_GRANT' },
          include: { entries: true },
        }),
      );
      expect(journals).toHaveLength(1);
      expect(journals[0]?.entries).toHaveLength(2);

      // Balanced.
      const delta = journals[0]!.entries.reduce(
        (total, entry) =>
          total + (entry.direction === 'DEBIT' ? entry.amountMinor : -entry.amountMinor),
        0n,
      );
      expect(delta).toBe(0n);

      await cleanup(prisma, [org.a]);
    });
  });

  describe('the period cap holds under parallel events', () => {
    it('never grants more than the cap, however many triggers arrive at once', async () => {
      // The mandatory scenario. Twenty simultaneous triggers against a rule
      // worth 10 points with a cap of 25 — an unguarded implementation grants
      // 200, a naively-guarded one grants somewhere between 30 and 200, and a
      // correct one grants exactly 25.
      await createRule({ points: 10, periodCap: 25, periodType: 'MONTH' });

      await Promise.all(
        Array.from({ length: 20 }, (_, index) => grant(`USG_PARALLEL_${index}_${ulid()}`)),
      );

      const total = await asActor({ organizationId: org.a }, () =>
        prisma.client.reward.aggregate({
          where: { organizationId: org.a, userId: user },
          _sum: { points: true },
        }),
      );

      expect(total._sum.points).toBe(25);

      const balance = await asActor({ organizationId: org.a }, () =>
        prisma.client.rewardBalance.findUnique({
          where: { organizationId_userId: { organizationId: org.a, userId: user } },
        }),
      );
      expect(balance?.totalPoints).toBe(25);

      await cleanup(prisma, [org.a]);
    });

    it('grants a partial amount at the edge rather than nothing or everything', async () => {
      // A cliff would discard earned behaviour; ignoring the cap would make it
      // decorative — and the cap is an anti-fraud control (docs/10 § 10.9).
      await createRule({ points: 10, periodCap: 15, periodType: 'MONTH' });

      await grant(`USG_EDGE_1_${ulid()}`);
      const second = await grant(`USG_EDGE_2_${ulid()}`);

      expect(second[0]).toMatchObject({ kind: 'GRANTED', points: 5 });

      const third = await grant(`USG_EDGE_3_${ulid()}`);
      expect(third[0]).toMatchObject({ kind: 'SKIPPED', reason: 'cap_reached' });

      await cleanup(prisma, [org.a]);
    });
  });

  describe('one fact earns once', () => {
    it('refuses a second grant for the same source, however it arrives', async () => {
      // `@@unique([ruleId, sourceReference])`. Idempotency and anti-fraud at
      // once: a replayed usage record cannot pay twice, and a resubmitted one
      // cannot either.
      await createRule({ points: 10 });

      const source = `USG_ONCE_${ulid()}`;
      const first = await grant(source);
      const second = await grant(source);

      expect(first[0]).toMatchObject({ kind: 'GRANTED' });
      expect(second[0]).toMatchObject({ kind: 'SKIPPED', reason: 'duplicate' });

      const rewards = await asActor({ organizationId: org.a }, () =>
        prisma.client.reward.findMany({ where: { sourceReference: source } }),
      );
      expect(rewards).toHaveLength(1);

      await cleanup(prisma, [org.a]);
    });

    it('refuses a duplicate even when the two arrive simultaneously', async () => {
      await createRule({ points: 10 });

      const source = `USG_RACE_${ulid()}`;
      const outcomes = await Promise.all([grant(source), grant(source), grant(source)]);

      const granted = outcomes.flat().filter((outcome) => outcome.kind === 'GRANTED');
      expect(granted).toHaveLength(1);

      await cleanup(prisma, [org.a]);
    });
  });

  describe('a reward needs a person', () => {
    it('grants nothing when the trigger names no user', async () => {
      // ADR-033: the reward model is about rewarding behaviour, and a level
      // nobody holds is not an incentive. `REWARD_GRANTED` carries a userId in
      // the catalogue, so there is nowhere to put "nobody".
      await createRule({ points: 10 });

      const outcomes = await asActor({ organizationId: org.a }, () =>
        wiring.rewards.grantFor({
          organizationId: org.a,
          userId: null,
          triggerEvent: 'USAGE_RECORDED',
          sourceReference: `USG_NOACTOR_${ulid()}`,
          occurredAt: new Date(),
          payload: {},
        }),
      );

      expect(outcomes).toEqual([]);

      await cleanup(prisma, [org.a]);
    });
  });

  describe('conditions', () => {
    it('withholds a grant whose condition is not met', async () => {
      await createRule({
        points: 10,
        condition: { field: 'hours', op: 'gte', value: '20' },
      });

      const outcomes = await grant(`USG_COND_${ulid()}`);
      expect(outcomes[0]).toMatchObject({ kind: 'SKIPPED', reason: 'condition_unmet' });

      await cleanup(prisma, [org.a]);
    });
  });

  describe('cashback stays behind its flag', () => {
    it('refuses to create a CASHBACK rule while the flag is off', async () => {
      // docs/24 Q-07: the product document conditions cashback on a regulatory
      // review that has not concluded. Refused rather than silently ignored — a
      // rule that exists and does nothing claims a control it does not have.
      await expect(createRule({ rewardType: 'CASHBACK', points: 10 })).rejects.toThrow(
        expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
      );
    });
  });

  describe('levels', () => {
    it('publishes a level change only when a threshold is actually crossed', async () => {
      await runUnscoped('the level test seeds a platform-wide ladder', () =>
        prisma.client.rewardLevel.createMany({
          data: [
            {
              id: `RWL_ITEST_0_${ulid()}`,
              organizationId: org.a,
              name: 'پایه',
              rank: 0,
              minPoints: 0,
              status: 'ACTIVE',
              createdBy: 'itest',
            },
            {
              id: `RWL_ITEST_1_${ulid()}`,
              organizationId: org.a,
              name: 'نقره‌ای',
              rank: 1,
              minPoints: 15,
              status: 'ACTIVE',
              createdBy: 'itest',
            },
          ],
        }),
      );

      await createRule({ points: 10 });

      const first = await grant(`USG_LVL_1_${ulid()}`);
      const second = await grant(`USG_LVL_2_${ulid()}`);
      const third = await grant(`USG_LVL_3_${ulid()}`);

      // 10 points reaches rank 0, 20 reaches rank 1, 30 changes nothing.
      expect(first[0]).toMatchObject({ levelChangedTo: 'پایه' });
      expect(second[0]).toMatchObject({ levelChangedTo: 'نقره‌ای' });
      expect(third[0]).toMatchObject({ levelChangedTo: null });

      await runUnscoped('the level test removes what it seeded', () =>
        prisma.client.rewardBalance.deleteMany({ where: { organizationId: org.a } }),
      );
      await runUnscoped('the level test removes what it seeded', () =>
        prisma.client.rewardLevel.deleteMany({ where: { organizationId: org.a } }),
      );
      await cleanup(prisma, [org.a]);
    });
  });
});
