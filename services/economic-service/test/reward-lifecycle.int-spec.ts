import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { asActor, cleanup, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * What a reward rule actually decides.
 *
 * `reward-cap.int-spec.ts` proves the anti-fraud ceiling holds under twenty
 * concurrent triggers. This file covers the rest of the decision surface, and
 * every case below changes whether a point is granted or money is recorded:
 *
 *  - a condition that does not match, and one that does
 *  - a platform-wide rule beside an organization-specific one
 *  - a rule outside its validity window
 *  - the monetised branch — the only path that posts a journal (ADR-033)
 *  - a level crossed, and a level that has not moved
 *  - a cashback rule while the regulatory review is outstanding
 *
 * The monetised branch is the one that matters most: with
 * `creditPerPointMinor` set, a reward stops being a display number and becomes
 * a recorded platform expense with a balanced journal behind it. Nothing in
 * the platform configures one today (docs/24 Q-09), so without this suite the
 * code that would run on the day somebody does has never executed.
 */
describe('reward lifecycle', () => {
  let prisma: PrismaService;
  let wiring: Wiring;

  const org = tenants();
  /**
   * Prefixed `USR-ITEST-` deliberately.
   *
   * A platform-wide rule has `organization_id = NULL`, so `cleanup` cannot
   * find it by tenant — it matches `created_by LIKE 'USR-ITEST-%'` instead.
   * Without that prefix this suite would leave an active platform-wide reward
   * rule behind on every run, and it would grant points in every later suite:
   * exactly the debris the helper's own comment says once made a leftover
   * commission rule reprice another test.
   */
  const USER = 'USR-ITEST-REWARD-LIFECYCLE';

  const asAdmin = <T>(fn: () => Promise<T>, organizationId = org.a): Promise<T> =>
    asActor({ organizationId, roles: ['SYSTEM_ADMIN'], userId: USER }, fn);

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  // JUSTIFIED-ANY: `CreateRewardRuleDto` is a Zod inference with several
  // optional shapes; spelling it out at each call site would restate the schema
  // rather than test anything.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rule = (overrides: Record<string, unknown>): any => ({
    triggerEvent: 'USAGE_RECORDED',
    rewardType: 'POINTS',
    points: 10,
    status: 'ACTIVE',
    ...overrides,
  });

  function grant(sourceReference: string, payload: Record<string, unknown> = {}, at = new Date()) {
    return wiring.rewards.grantFor({
      organizationId: org.a,
      userId: USER,
      triggerEvent: 'USAGE_RECORDED',
      sourceReference,
      occurredAt: at,
      payload,
    });
  }

  const rewardsFor = (sourceReference: string) =>
    runUnscoped('the reward suite verifies across tenants what it wrote', () =>
      prisma.client.reward.findMany({ where: { sourceReference } }),
    );

  // -------------------------------------------------------------------------

  it('grants nothing when no rule is configured', async () => {
    // The honest state of this platform today, and it is a state rather than a
    // gap: no reward rate has been approved (docs/24 Q-09).
    const outcomes = await asAdmin(() => grant(`USG_${ulid()}`));
    expect(outcomes).toEqual([]);
  });

  it('grants nothing when the trigger names no subject', async () => {
    const outcomes = await asAdmin(() =>
      wiring.rewards.grantFor({
        organizationId: org.a,
        userId: null,
        triggerEvent: 'USAGE_RECORDED',
        sourceReference: `USG_${ulid()}`,
        occurredAt: new Date(),
        payload: {},
      }),
    );
    // Points for "the system" would be a fabricated subject.
    expect(outcomes).toEqual([]);
  });

  it('applies a rule only when its condition matches the payload', async () => {
    await asAdmin(() =>
      wiring.rewards.createRule(
        rule({
          organizationId: org.a,
          points: 7,
          condition: { field: 'assetType', op: 'eq', value: 'GRADER' },
        }),
      ),
    );

    const missed = `USG_${ulid()}`;
    expect(await asAdmin(() => grant(missed, { assetType: 'TRUCK' }))).toEqual([
      expect.objectContaining({ kind: 'SKIPPED' }),
    ]);
    expect(await rewardsFor(missed)).toHaveLength(0);

    const matched = `USG_${ulid()}`;
    expect(await asAdmin(() => grant(matched, { assetType: 'GRADER' }))).toEqual([
      expect.objectContaining({ kind: 'GRANTED', points: 7, monetised: false }),
    ]);
    expect(await rewardsFor(matched)).toHaveLength(1);
  });

  it('applies a platform-wide rule alongside an organization-specific one', async () => {
    // An organization rule does not replace a platform rule here — both grant.
    // Precedence exists for commission, where one rate must win; a reward
    // programme is additive by nature.
    await asAdmin(() =>
      wiring.rewards.createRule(rule({ points: 2, triggerEvent: 'MAINTENANCE_COMPLETED' })),
    );
    await asAdmin(() =>
      wiring.rewards.createRule(
        rule({ organizationId: org.a, points: 3, triggerEvent: 'MAINTENANCE_COMPLETED' }),
      ),
    );

    const source = `MNT_${ulid()}`;
    const outcomes = await asAdmin(() =>
      wiring.rewards.grantFor({
        organizationId: org.a,
        userId: USER,
        triggerEvent: 'MAINTENANCE_COMPLETED',
        sourceReference: source,
        occurredAt: new Date(),
        payload: {},
      }),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'GRANTED')).toHaveLength(2);
    const granted = await rewardsFor(source);
    expect(granted.map((row) => row.points).sort()).toEqual([2, 3]);
  });

  it('ignores a rule whose validity window has closed', async () => {
    const yesterday = new Date(Date.now() - 48 * 3600_000);
    const closedAt = new Date(Date.now() - 24 * 3600_000);

    await asAdmin(
      () =>
        wiring.rewards.createRule(
          rule({
            organizationId: org.b,
            points: 99,
            validFrom: yesterday.toISOString(),
            validTo: closedAt.toISOString(),
          }),
        ),
      org.b,
    );

    const source = `USG_${ulid()}`;
    const outcomes = await asActor({ organizationId: org.b, userId: USER }, () =>
      wiring.rewards.grantFor({
        organizationId: org.b,
        userId: USER,
        triggerEvent: 'USAGE_RECORDED',
        sourceReference: source,
        occurredAt: new Date(),
        payload: {},
      }),
    );

    // Rules are versioned in time. A closed rule is history, not configuration.
    expect(outcomes).toEqual([]);
    expect(await rewardsFor(source)).toHaveLength(0);
  });

  it('posts a balanced journal for a monetised reward, and only for one', async () => {
    await asAdmin(
      () =>
        wiring.rewards.createRule(
          rule({ organizationId: org.c, points: 4, creditPerPointMinor: '2500' }),
        ),
      org.c,
    );

    const source = `USG_${ulid()}`;
    const [outcome] = await asActor({ organizationId: org.c, userId: USER }, () =>
      wiring.rewards.grantFor({
        organizationId: org.c,
        userId: USER,
        triggerEvent: 'USAGE_RECORDED',
        sourceReference: source,
        occurredAt: new Date(),
        payload: {},
      }),
    );

    expect(outcome).toEqual(
      expect.objectContaining({ kind: 'GRANTED', points: 4, monetised: true }),
    );

    const [reward] = await rewardsFor(source);
    // Four points at 2 500 rial each — a real recorded platform expense, not a
    // display number (docs/10 § 10.4's third example).
    expect(reward!.creditAmountMinor).toBe(10_000n);
    expect(reward!.monetised).toBe(true);
    expect(reward!.journalId).not.toBeNull();

    const entries = await runUnscoped('the suite reads the reward journal across tenants', () =>
      prisma.client.ledgerEntry.findMany({ where: { journalId: reward!.journalId! } }),
    );
    expect(entries.length).toBeGreaterThanOrEqual(2);
    let delta = 0n;
    for (const entry of entries) {
      delta += entry.direction === 'DEBIT' ? entry.amountMinor : -entry.amountMinor;
    }
    expect(delta).toBe(0n);

    // And the credit really reached the wallet.
    const wallet = await asActor({ organizationId: org.c }, () => wiring.wallets.getOrOpen('IRR'));
    expect(wallet.ledgerBalanceMinor).toBeGreaterThanOrEqual(10_000n);
  });

  it('publishes a level change only when the level actually moves', async () => {
    const levelId = `RLV_${ulid()}`;
    await runUnscoped('the suite configures a level ladder for one organization', () =>
      prisma.client.rewardLevel.create({
        data: {
          id: levelId,
          organizationId: org.a,
          name: 'نقره‌ای',
          rank: 1,
          minPoints: 1,
          status: 'ACTIVE',
          createdBy: 'USR-ITEST-REWARD-LIFECYCLE',
        },
      }),
    );

    await asAdmin(() =>
      wiring.rewards.createRule(
        rule({ organizationId: org.a, points: 1, triggerEvent: 'MAINTENANCE_COMPLETED' }),
      ),
    );

    const first = await asAdmin(() =>
      wiring.rewards.grantFor({
        organizationId: org.a,
        userId: 'USR-LEVEL-SUBJECT',
        triggerEvent: 'MAINTENANCE_COMPLETED',
        sourceReference: `MNT_${ulid()}`,
        occurredAt: new Date(),
        payload: {},
      }),
    );
    expect(first.some((outcome) => outcome.levelChangedTo === 'نقره‌ای')).toBe(true);

    const second = await asAdmin(() =>
      wiring.rewards.grantFor({
        organizationId: org.a,
        userId: 'USR-LEVEL-SUBJECT',
        triggerEvent: 'MAINTENANCE_COMPLETED',
        sourceReference: `MNT_${ulid()}`,
        occurredAt: new Date(),
        payload: {},
      }),
    );
    // A level that has not moved is not news, and notification-service would
    // otherwise turn every single reward into a message.
    expect(second.every((outcome) => outcome.levelChangedTo === null)).toBe(true);

    await runUnscoped('the suite removes the ladder it configured', () =>
      prisma.client.rewardLevel.delete({ where: { id: levelId } }),
    );
  });

  it('refuses a cashback rule while the regulatory review is outstanding', async () => {
    // Refused at configuration time rather than accepted and silently ignored:
    // a rule that exists, is ACTIVE and does nothing is a control claiming
    // something it does not have (docs/24 Q-07).
    await expect(
      asAdmin(() =>
        wiring.rewards.createRule(rule({ organizationId: org.a, rewardType: 'CASHBACK' })),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
  });

  it('reads back the caller’s own standing, and nobody else’s', async () => {
    await asAdmin(() =>
      wiring.rewards.createRule(
        rule({ organizationId: org.a, points: 6, triggerEvent: 'MAINTENANCE_COMPLETED' }),
      ),
    );
    await asAdmin(() =>
      wiring.rewards.grantFor({
        organizationId: org.a,
        userId: USER,
        triggerEvent: 'MAINTENANCE_COMPLETED',
        sourceReference: `MNT_${ulid()}`,
        occurredAt: new Date(),
        payload: {},
      }),
    );

    const mine = await asActor({ organizationId: org.a, userId: USER }, () =>
      wiring.rewards.myRewards(25),
    );
    expect(mine.balance?.userId).toBe(USER);
    expect(mine.rewards.length).toBeGreaterThan(0);

    // There is no endpoint that reads another user's standing: it is
    // behavioural data about a person, and nothing in the product document
    // asks for it to be visible to anyone else.
    const stranger = await asActor({ organizationId: org.a, userId: 'USR-SOMEBODY-ELSE' }, () =>
      wiring.rewards.myRewards(25),
    );
    expect(stranger.rewards).toHaveLength(0);
  });
});
