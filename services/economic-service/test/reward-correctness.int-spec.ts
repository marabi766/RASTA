import { eligibilityClockWrite } from '@rasta/testing';
import { ulid } from 'ulid';
import { runUnscoped, type EventConsumer } from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import { RewardGrantError } from '../src/reward/reward.service';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { recordCutoverIfMissing } from '../src/reward/evaluation-cutover';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { CreateRewardRuleDto } from '../src/reward/dto';
import {
  asActor,
  cleanup,
  newPrisma,
  readBalances,
  tenants,
  unanswered,
  wire,
  type Wiring,
} from './helpers';
import { FakeSourceFacts } from './source-facts.fake';

describe('reward correctness F4–F7 (PostgreSQL)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let wiring: Wiring;
  let consumer: RewardTriggerConsumer;
  const sources = new FakeSourceFacts();
  const user = `USR_${ulid()}`;
  const admin = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, fn);

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    consumer = new RewardTriggerConsumer(
      () =>
        ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer,
      prisma,
      wiring.rewards,
      sources,
    );
    await runUnscoped('record the operator cutover for these verified fixtures', () =>
      recordCutoverIfMissing(prisma.client, new Date('2021-01-01T00:00:00Z')),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanup(prisma, [org.a, org.b, org.c]);
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  function rule(extra: Partial<CreateRewardRuleDto> = {}) {
    return admin(() =>
      wiring.rewards.createRule(
        {
          organizationId: org.a,
          triggerEvent: 'USAGE_RECORDED',
          rewardType: 'POINTS',
          status: 'ACTIVE',
          points: 10,
          validFrom: '2010-01-01T00:00:00Z',
          ...extra,
        },
        unanswered(),
      ),
    );
  }
  function grant(
    at: string,
    sourceReference = `USG_${ulid()}`,
    organizationId = org.a,
    userId = user,
  ) {
    return admin(() =>
      wiring.rewards.grantFor({
        organizationId,
        userId,
        triggerEvent: 'USAGE_RECORDED',
        sourceReference,
        occurredAt: new Date(at),
        payload: { hours: '8' },
      }),
    );
  }
  function event(recordedAt: string, subject = user): EventEnvelope {
    const payload = {
      usageRecordId: `USG_${ulid()}`,
      assetId: `AST_${ulid()}`,
      organizationId: org.a,
      hours: '8',
    };
    sources.recorded(payload, { recordedAt, recordedBy: subject });
    return {
      eventId: ulid(),
      eventName: 'USAGE_RECORDED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'fleet-service',
      producerVersion: '0.1.0',
      aggregateType: 'UsageRecord',
      aggregateId: payload.usageRecordId,
      tenantId: org.a,
      correlationId: ulid(),
      payload,
    } as EventEnvelope;
  }
  const rows = () =>
    runUnscoped('read only the grants belonging to this test tenant', () =>
      prisma.client.reward.findMany({ where: { organizationId: org.a } }),
    );

  it('F4: two different users observe no wallet; the losing transaction is retryable and both credits survive redelivery', async () => {
    await rule({ creditPerPointMinor: '1000' });
    // Pre-existing accounts prevent an account race obscuring the wallet P2002.
    await admin(() =>
      prisma.transaction(async (tx) => {
        await wiring.ledger.resolveAccount(tx, 'WALLET', org.a, 'IRR', 'itest');
        await wiring.ledger.resolveAccount(tx, 'ESCROW', org.a, 'IRR', 'itest');
        await wiring.ledger.resolveAccount(tx, 'REWARD_EXPENSE', org.a, 'IRR', 'itest');
      }),
    );
    let observed = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = wiring.walletRepository.findByOrganizationUnscoped.bind(wiring.walletRepository);
    // Production only awaits this lookup; the barrier does not use Prisma's fluent relation methods.
    const lookup = jest
      .spyOn(wiring.walletRepository, 'findByOrganizationUnscoped')
      .mockImplementation(
        (...args: Parameters<typeof real>) =>
          (async () => {
            const wallet = await real(...args);
            if (!wallet && args[1] === org.a) {
              observed++;
              if (observed === 2) release();
              await barrier;
            }
            return wallet;
          })() as ReturnType<typeof real>,
      );
    const events = [
      event(new Date().toISOString(), `${user}-A`),
      event(new Date().toISOString(), `${user}-B`),
    ];
    const outcomes = await Promise.allSettled(events.map((envelope) => consumer.handle(envelope)));
    lookup.mockRestore();
    expect(observed).toBe(2);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.findIndex((outcome) => outcome.status === 'rejected');
    const failure = outcomes[loser] as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(RewardGrantError);
    expect((failure.reason as RewardGrantError).permanent).toBe(false);
    expect((failure.reason as RewardGrantError).failures[0]?.error).toMatchObject({
      code: 'P2002',
      meta: { modelName: 'Wallet' },
    });
    const marker = await runUnscoped(
      'a rolled back credit must not mark its envelope processed',
      () =>
        prisma.client.processedEvent.findUnique({
          where: {
            eventId_consumerName: {
              eventId: events[loser]!.eventId,
              consumerName: RewardTriggerConsumer.CONSUMER_NAME,
            },
          },
        }),
    );
    expect(marker).toBeNull();
    await expect(consumer.handle(events[loser]!)).resolves.toBeUndefined();
    await expect(consumer.handle(events[loser]!)).resolves.toBe('SKIPPED');
    expect(await rows()).toHaveLength(2);
    const wallet = await admin(() => wiring.wallets.getOrOpen('IRR'));
    expect(await readBalances(prisma, wallet.id)).toMatchObject({
      available: 20_000n,
      ledger: 20_000n,
    });
    const journals = await runUnscoped('read the journals generated by these two rewards', () =>
      prisma.client.journal.findMany({
        where: { organizationId: org.a, journalType: 'REWARD_GRANT' },
        include: { entries: true },
      }),
    );
    expect(journals).toHaveLength(2);
    for (const journal of journals) {
      expect(journal.entries).toHaveLength(2);
      expect(
        journal.entries.reduce(
          (sum, entry) =>
            sum + (entry.direction === 'DEBIT' ? entry.amountMinor : -entry.amountMinor),
          0n,
        ),
      ).toBe(0n);
    }
  });

  it('F5: an owner-confirmed cost below an exact monetary threshold has zero financial effect', async () => {
    await rule({
      triggerEvent: 'MAINTENANCE_COMPLETED',
      creditPerPointMinor: '1000',
      condition: { field: 'totalCostMinor', op: 'gte', value: '9007199254740993' },
    });
    const payload = { requestId: `MNT_${ulid()}`, assetId: `AST_${ulid()}`, organizationId: org.a };
    sources.completed(payload, { totalCostMinor: '9007199254740992', completedBy: user });
    const e = {
      ...event(new Date().toISOString()),
      eventName: 'MAINTENANCE_COMPLETED',
      producer: 'maintenance-service',
      aggregateType: 'MaintenanceRequest',
      aggregateId: payload.requestId,
      payload,
    };
    await consumer.handle(e);
    expect(await rows()).toHaveLength(0);
    const financial = await runUnscoped(
      'no prohibited financial writes on a failed predicate',
      async () => ({
        wallets: await prisma.client.wallet.count({ where: { organizationId: org.a } }),
        journals: await prisma.client.journal.count({ where: { organizationId: org.a } }),
      }),
    );
    expect(financial).toEqual({ wallets: 0, journals: 0 });
  });

  it('F4: a duplicate requires the same tenant, subject, trigger and source identity', async () => {
    const r = await rule({ organizationId: undefined });
    const source = `USG_${ulid()}`;
    await grant('2026-10-30T00:00:00Z', source);
    expect(await grant('2026-10-30T00:00:00Z', source)).toEqual([
      expect.objectContaining({ kind: 'SKIPPED', reason: 'duplicate' }),
    ]);
    for (const [tenant, subject] of [
      [org.b, user],
      [org.a, `${user}-other`],
    ]) {
      await expect(grant('2026-10-30T00:00:00Z', source, tenant, subject)).rejects.toMatchObject({
        permanent: false,
        failures: [expect.objectContaining({ ruleId: r.id })],
      });
    }
    expect(await rows()).toHaveLength(1);
  });

  it('F6: concurrent cutover grants share one ISO week cap', async () => {
    await rule({ periodType: 'WEEK', periodCap: 15 });
    const result = await Promise.all([
      grant('2026-12-31T23:59:59Z'),
      grant('2027-01-01T00:00:00Z'),
    ]);
    expect(
      result
        .flat()
        .reduce((sum, outcome) => sum + (outcome.kind === 'GRANTED' ? outcome.points : 0), 0),
    ).toBe(15);
    expect((await rows()).map((row) => row.periodKey)).toEqual(['2026-W53', '2026-W53']);
  });

  async function legacy(
    points: number,
    periodKey: string,
    occurredAt: string | null,
    evaluationAt: string | null = null,
  ) {
    const r = await rule({ periodType: 'WEEK', periodCap: 10 });
    const source = `USG_${ulid()}`;
    await runUnscoped('seed a legacy grant without changing its stored key', async () => {
      await prisma.client.reward.create({
        data: {
          id: `RWD_${ulid()}`,
          organizationId: org.a,
          userId: user,
          ruleId: r.id,
          triggerEvent: 'USAGE_RECORDED',
          sourceReference: source,
          points,
          periodKey,
          occurredAt: occurredAt ? new Date(occurredAt) : null,
          grantedAt: new Date('2030-06-01T00:00:00Z'),
        },
      });
      if (evaluationAt) {
        const evaluatedBy = ulid();
        await eligibilityClockWrite(prisma.client)`
          INSERT INTO reward_source_evaluation
            (organization_id, trigger_event, source_reference, origin, outcome, event_id, rule_ids, subject_user_id, occurred_at)
          VALUES (${org.a}, 'USAGE_RECORDED', ${source}, 'EVENT', 'EVALUATED', ${evaluatedBy}, ARRAY[${r.id}], ${user}, ${new Date(evaluationAt)})
        `;
      }
    });
    return r;
  }
  it('F6: concurrent grants after deployment count the legacy cutover grant under its old key', async () => {
    await legacy(5, '2027-W53', null);
    await Promise.all([grant('2026-12-31T23:59:59Z'), grant('2027-01-01T00:00:00Z')]);
    expect((await rows()).reduce((sum, row) => sum + row.points, 0)).toBe(10);
  });

  it.each([null, '2026-12-31T00:00:00Z'])(
    'F6: legacy grants (occurrence %s) cannot reopen a cap already exceeded',
    async (at) => {
      await legacy(20, '2027-W53', at);
      expect(await grant('2026-12-31T00:00:00Z')).toEqual([
        expect.objectContaining({ reason: 'cap_reached' }),
      ]);
      expect(await rows()).toHaveLength(1);
    },
  );
  it.each([false, true])(
    'F6: known occurrence separates weeks conflated by 2018-W01 (evaluation evidence %s)',
    async (viaEvaluation) => {
      const at = '2018-01-01T00:00:00Z';
      await legacy(10, '2018-W01', viaEvaluation ? null : at, viaEvaluation ? at : null);
      expect(await grant('2018-12-31T00:00:00Z')).toEqual([
        expect.objectContaining({ kind: 'GRANTED', points: 10 }),
      ]);
      expect(await grant(at)).toEqual([expect.objectContaining({ reason: 'cap_reached' })]);
    },
  );
  it('F6: unknown occurrence counts conservatively in both weeks a legacy key can represent', async () => {
    await legacy(10, '2018-W01', null);
    for (const at of ['2018-01-01T00:00:00Z', '2018-12-31T00:00:00Z']) {
      expect(await grant(at)).toEqual([expect.objectContaining({ reason: 'cap_reached' })]);
    }
  });

  it('D-080: delayed fact before deactivation pays once; later fact does not, regardless of reported usage period', async () => {
    const r = await rule();
    const before = event('2026-10-01T00:00:00Z');
    await admin(() => wiring.rewards.updateRule(r.id, { status: 'INACTIVE' }));
    await expect(consumer.handle(before)).resolves.toBeUndefined();
    expect(await rows()).toHaveLength(1);
    await expect(consumer.handle(before)).resolves.toBe('SKIPPED');
    await expect(consumer.handle({ ...before, eventId: ulid() })).resolves.toBe('SKIPPED');
    const after = event('2030-01-01T00:00:00Z');
    const fact = sources.usage.get(
      String((after.payload as { usageRecordId: string }).usageRecordId),
    )!;
    fact.periodStart = '2026-10-01T00:00:00Z';
    fact.periodEnd = '2026-10-01T08:00:00Z';
    await consumer.handle(after);
    expect(await rows()).toHaveLength(1);
  });

  it('D-080: same-envelope resume retains saved rules after deactivation; a NEW event id cannot take over', async () => {
    const r = await rule();
    const e = event('2026-10-01T00:00:00Z');
    const crash = jest
      .spyOn(wiring.rewards, 'grantFor')
      .mockRejectedValueOnce(new Error('process died'));
    await expect(consumer.handle(e)).rejects.toThrow('process died');
    crash.mockRestore();
    await admin(() => wiring.rewards.updateRule(r.id, { status: 'INACTIVE' }));
    await expect(consumer.handle({ ...e, eventId: ulid() })).resolves.toBe('SKIPPED');
    expect(await rows()).toHaveLength(0);
    await consumer.handle(e);
    expect(await rows()).toHaveLength(1);
    await expect(consumer.handle(e)).resolves.toBe('SKIPPED');
  });

  it('D-080: initially INACTIVE, activation, repeated transitions and relabeling retain their effective intervals', async () => {
    const r = await rule({ status: 'INACTIVE' });
    const history = () =>
      runUnscoped('read status evidence only through this tenant rule', () =>
        prisma.client.rewardRule.findFirstOrThrow({
          where: { id: r.id, organizationId: org.a },
          include: { statusHistory: { orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }] } },
        }),
      );
    const idsAt = (at: Date) => wiring.rewards.applicableRuleIds(org.a, 'USAGE_RECORDED', at);
    expect(await idsAt(new Date('2026-10-01T00:00:00Z'))).toEqual([]);
    for (const status of ['ACTIVE', 'INACTIVE', 'ACTIVE', 'INACTIVE'] as const) {
      await admin(() => wiring.rewards.updateRule(r.id, { status }));
      const evidence = await history();
      expect(await idsAt(evidence.statusHistory[0]!.effectiveAt)).toEqual(
        status === 'ACTIVE' ? [r.id] : [],
      );
    }
    const before = await history();
    await admin(() => wiring.rewards.updateRule(r.id, { status: 'INACTIVE', label: 'relabeled' }));
    expect((await history()).statusHistory).toEqual(before.statusHistory);
    expect(before.statusHistory).toHaveLength(5);
    await expect(
      runUnscoped('history must be append-only even to raw queries', () =>
        prisma.client.rewardRuleStatusHistory.update({
          where: { id: before.statusHistory[0]!.id },
          data: { status: 'ACTIVE' },
        }),
      ),
    ).rejects.toThrow('append-only');
    await expect(
      runUnscoped('history cannot be deleted by the runtime', () =>
        prisma.client.rewardRuleStatusHistory.delete({
          where: { id: before.statusHistory[0]!.id },
        }),
      ),
    ).rejects.toThrow('append-only');
  });

  it('D-080: deactivation before a future validFrom does not schedule reactivation', async () => {
    const r = await rule({ validFrom: '2030-01-01T00:00:00Z' });
    await admin(() => wiring.rewards.updateRule(r.id, { status: 'INACTIVE' }));
    expect(await grant('2031-01-01T00:00:00Z')).toEqual([]);
  });

  it('D-080: a failed change event rolls back the status and its history together', async () => {
    const r = await rule();
    const unavailable = jest
      .spyOn(wiring.ledger, 'enqueue')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(
      admin(() => wiring.rewards.updateRule(r.id, { status: 'INACTIVE' })),
    ).rejects.toThrow('outbox unavailable');
    unavailable.mockRestore();
    const stored = await runUnscoped(
      'read only this tenant’s rule and its transactional history',
      () =>
        prisma.client.rewardRule.findFirstOrThrow({
          where: { id: r.id, organizationId: org.a },
          include: { statusHistory: true },
        }),
    );
    expect(stored.status).toBe('ACTIVE');
    expect(stored.statusHistory).toHaveLength(1);
    expect(stored.statusHistory[0]?.status).toBe('ACTIVE');
  });

  it('D-080: closing keeps pre-close facts eligible and excludes the end instant', async () => {
    const r = await rule();
    const end = new Date(Date.now() + 60_000);
    await admin(() => wiring.rewards.updateRule(r.id, { validTo: end.toISOString() }));
    expect(
      await wiring.rewards.applicableRuleIds(org.a, 'USAGE_RECORDED', new Date(end.getTime() - 1)),
    ).toEqual([r.id]);
    expect(await wiring.rewards.applicableRuleIds(org.a, 'USAGE_RECORDED', end)).toEqual([]);
  });

  it('tenant isolation: history and weekly cap reads cannot select or consume another tenant rule', async () => {
    await rule({ periodType: 'WEEK', periodCap: 10 });
    expect(await grant('2026-12-31T00:00:00Z', undefined, org.b)).toEqual([]);
    expect(await wiring.rewards.applicableRuleIds(org.b, 'USAGE_RECORDED', new Date())).toEqual([]);
    expect(await grant('2026-12-31T00:00:00Z')).toEqual([expect.objectContaining({ points: 10 })]);
    const foreign = await asActor({ organizationId: org.b, userId: user }, () =>
      wiring.rewards.myRewards(25),
    );
    expect(foreign).toMatchObject({ balance: null, rewards: [] });
  });
});
