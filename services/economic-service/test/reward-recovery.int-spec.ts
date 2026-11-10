import { ulid } from 'ulid';
import { runUnscoped, type EventConsumer } from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import { MAX_AMOUNT_MINOR } from '@rasta/contracts';
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
  testEnv,
  type Wiring,
} from './helpers';
import { FakeSourceFacts } from './source-facts.fake';

describe('reward recovery R1–R2 (PostgreSQL)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let wiring: Wiring;
  let consumer: RewardTriggerConsumer;
  const sources = new FakeSourceFacts();
  const env = testEnv();
  env.ECONOMIC_REWARD_CASHBACK_ENABLED = true;
  const user = `USR_${ulid()}`;
  const admin = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, fn);

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma, env);
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
    await prisma.stop();
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

  it.each(['points', 'lifetime', 'wallet', 'period-cap', 'cashback-flag'] as const)(
    'R1: committed grant at %s boundary resumes without another financial effect',
    async (boundary) => {
      await rule({
        points: 1,
        creditPerPointMinor: '1',
        ...(boundary === 'period-cap' ? { periodCap: 1, periodType: 'DAY' } : {}),
        ...(boundary === 'cashback-flag' ? { rewardType: 'CASHBACK' } : {}),
      });
      await admin(() =>
        prisma.transaction(async (tx) => {
          await tx.rewardBalance.create({
            data: {
              organizationId: org.a,
              userId: user,
              totalPoints: boundary === 'points' ? 2147483646 : 0,
              lifetimeCreditMinor: boundary === 'lifetime' ? MAX_AMOUNT_MINOR - 1n : 0n,
            },
          });
          if (boundary === 'wallet') {
            const wallet = await wiring.wallets.resolveCounterpartyWallet(tx, org.a, 'IRR');
            await wiring.wallets.credit(tx, {
              wallet,
              amountMinor: MAX_AMOUNT_MINOR - 1n,
              counterpartPurpose: 'REWARD_EXPENSE',
              journalType: 'REWARD_GRANT',
              description: 'recovery capacity fixture',
              postedBy: 'itest',
            });
          }
        }),
      );
      const e = event(new Date().toISOString());
      // Crash AFTER grantFor committed, BEFORE processed_event is committed.
      const real = wiring.rewards.grantFor.bind(wiring.rewards);
      const crash = jest.spyOn(wiring.rewards, 'grantFor').mockImplementationOnce(async (input) => {
        await real(input);
        throw new Error('post-grant process loss');
      });
      await expect(consumer.handle(e)).rejects.toThrow('post-grant process loss');
      crash.mockRestore();
      const marker = () =>
        runUnscoped('inspect this recovery envelope marker', () =>
          prisma.client.processedEvent.findUnique({
            where: {
              eventId_consumerName: {
                eventId: e.eventId,
                consumerName: RewardTriggerConsumer.CONSUMER_NAME,
              },
            },
          }),
        );
      expect(await marker()).toBeNull();
      const before = await rows();
      expect(before).toHaveLength(1);
      const wallet = await admin(() => wiring.wallets.getOrOpen('IRR'));
      const balances = await readBalances(prisma, wallet.id);
      const journalCount = () =>
        runUnscoped('count this tenant financial effects', () =>
          prisma.client.journal.count({ where: { organizationId: org.a } }),
        );
      const journals = await journalCount();
      if (boundary === 'cashback-flag') env.ECONOMIC_REWARD_CASHBACK_ENABLED = false;
      const resume = jest.spyOn(wiring.rewards, 'grantFor');
      try {
        await expect(consumer.handle(e)).resolves.toBeUndefined();
        expect(await resume.mock.results[0]?.value).toEqual([
          expect.objectContaining({ kind: 'SKIPPED', reason: 'duplicate' }),
        ]);
        expect(await marker()).not.toBeNull();
        expect(await rows()).toEqual(before);
        expect(await readBalances(prisma, wallet.id)).toEqual(balances);
        expect(await journalCount()).toBe(journals);
      } finally {
        resume.mockRestore();
        env.ECONOMIC_REWARD_CASHBACK_ENABLED = true;
      }
    },
  );

  const schedules = (['deactivate', 'activate', 'create', 'close'] as const).flatMap((change) =>
    [false, true].flatMap((global) =>
      ['USAGE_RECORDED', 'MAINTENANCE_COMPLETED'].map(
        (trigger) => [change, global, trigger] as const,
      ),
    ),
  );
  it.each(schedules)(
    'R2: held %s writer (global %s, %s) fences selection and durable claim',
    async (change, global, trigger) => {
      const extra = {
        organizationId: global ? undefined : org.a,
        triggerEvent: trigger as CreateRewardRuleDto['triggerEvent'],
      };
      const r =
        change === 'create'
          ? null
          : await rule({ ...extra, status: change === 'activate' ? 'INACTIVE' : 'ACTIVE' });
      let entered!: () => void;
      let release!: () => void;
      const enteredWriter = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const heldWriter = new Promise<void>((resolve) => {
        release = resolve;
      });
      const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
      const hold = jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (...args) => {
        await enqueue(...args);
        if (args[1].eventName === 'REWARD_RULE_CHANGED') {
          entered();
          await heldWriter;
        }
      });
      const writer =
        change === 'create'
          ? rule(extra)
          : admin(() =>
              wiring.rewards.updateRule(
                r!.id,
                change === 'close'
                  ? { validTo: '2089-01-01T00:00:00Z' }
                  : { status: change === 'activate' ? 'ACTIVE' : 'INACTIVE' },
              ),
            );
      await enteredWriter;
      const e = event('2090-01-01T00:00:00Z');
      if (trigger === 'MAINTENANCE_COMPLETED') {
        const payload = {
          requestId: `MNT_${ulid()}`,
          assetId: `AST_${ulid()}`,
          organizationId: org.a,
        };
        sources.completed(payload, { completedAt: '2090-01-01T00:00:00Z', completedBy: user });
        Object.assign(e, {
          eventName: trigger,
          producer: 'maintenance-service',
          aggregateType: 'MaintenanceRequest',
          aggregateId: payload.requestId,
          payload,
        });
      }
      let settled = false;
      const reader = consumer.handle(e).finally(() => {
        settled = true;
      });
      try {
        // Observe a real PostgreSQL advisory-lock wait, not a timing sleep.
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (!settled && !blocked && Date.now() < deadline) {
          const [lock] = await prisma.client.$queryRaw<{ blocked: boolean }[]>`
            SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
              AND objid = 5451209 AND NOT granted) AS blocked`;
          blocked = lock?.blocked ?? false;
        }
        expect(blocked).toBe(true);
        expect(
          await runUnscoped('no premature evaluation for this tenant', () =>
            prisma.client.rewardSourceEvaluation.count({
              where: { organizationId: org.a, eventId: e.eventId },
            }),
          ),
        ).toBe(0);
      } finally {
        release();
        await writer;
        hold.mockRestore();
        await reader;
      }
      const evaluation = await runUnscoped('read this tenant durable selection', () =>
        prisma.client.rewardSourceEvaluation.findFirstOrThrow({
          where: { organizationId: org.a, eventId: e.eventId },
        }),
      );
      const pays = change === 'activate' || change === 'create';
      expect(evaluation.outcome).toBe(pays ? 'EVALUATED' : 'NO_RULE');
      expect(evaluation.ruleIds).toHaveLength(pays ? 1 : 0);
      expect(await rows()).toHaveLength(pays ? 1 : 0);
      await expect(consumer.handle(e)).resolves.toBe('SKIPPED');
    },
  );
  it('R2: a writer cannot pass selection until its durable claim commits; saved rules still pay', async () => {
    const r = await rule();
    const e = event('2090-01-01T00:00:00Z');
    let selected!: () => void;
    let release!: () => void;
    const selection = new Promise<void>((resolve) => {
      selected = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = wiring.rewards.applicableRuleIds.bind(wiring.rewards);
    const held = jest
      .spyOn(wiring.rewards, 'applicableRuleIds')
      .mockImplementation(async (...args) => {
        const ids = await real(...args);
        selected();
        await gate;
        return ids;
      });
    const reader = consumer.handle(e);
    await selection;
    let settled = false;
    const writer = admin(() => wiring.rewards.updateRule(r.id, { status: 'INACTIVE' })).finally(
      () => {
        settled = true;
      },
    );
    try {
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (!settled && !blocked && Date.now() < deadline) {
        const [lock] = await prisma.client.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
            AND objid = 5451209 AND NOT granted) AS blocked`;
        blocked = lock?.blocked ?? false;
      }
      expect(blocked).toBe(true);
    } finally {
      release();
      await Promise.all([reader, writer]);
      held.mockRestore();
    }
    const evaluation = await runUnscoped('read only this claimed fact', () =>
      prisma.client.rewardSourceEvaluation.findFirstOrThrow({
        where: { organizationId: org.a, eventId: e.eventId },
      }),
    );
    expect(evaluation.ruleIds).toEqual([r.id]);
    expect(await rows()).toHaveLength(1);
    await expect(consumer.handle(e)).resolves.toBe('SKIPPED');
  });
});
