import { Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import {
  runUnscoped,
  WorkerAbandonedError,
  type EventConsumer,
  type HandlerOutcome,
} from '@rasta/nest-common';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { withCommitReporting } from '../src/prisma/commit-reporting';
import { recordCutoverIfMissing } from '../src/reward/evaluation-cutover';
import {
  journalsPostedTotal,
  ledgerEntriesTotal,
  rewardGrantFailuresTotal,
  rewardsGrantedTotal,
  sourceVerificationsTotal,
} from '../src/observability/metrics';
import { asActor, cleanup, newPrisma, tenants, unanswered, wire } from './helpers';
import { FakeSourceFacts } from './source-facts.fake';

jest.mock('../src/prisma/commit-reporting', () => {
  const actual = jest.requireActual<typeof import('../src/prisma/commit-reporting')>(
    '../src/prisma/commit-reporting',
  );
  return { ...actual, withCommitReporting: jest.fn(actual.withCommitReporting) };
});
const originalReporting = jest.requireActual<typeof import('../src/prisma/commit-reporting')>(
  '../src/prisma/commit-reporting',
).withCommitReporting;

// Delay the real driver's transaction result BEFORE commit reporting sees it.
// Both late fulfillment and rejection may hide an already committed grant.
describe.each(['direct', 'framework'] as const)('reward abandonment (%s)', (entry) => {
  it.each([
    'precommit',
    'committed',
    'rejected',
    'grant-resolved',
    'grant-rejected',
    'source-resolved',
    'source-rejected',
  ] as const)('%s response stays unconfirmed; replay grants once', async (phase) => {
    const org = tenants();
    const apiHold = phase.startsWith('grant-');
    const sourceHold = phase.startsWith('source-');
    const reported = apiHold ? 1 : 0;
    let running: Promise<HandlerOutcome> | undefined;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let armed = false;
    const wait = async <T>(result: T): Promise<T> => {
      entered();
      await held;
      if (phase.endsWith('rejected')) throw new Error('committed response lost');
      return result;
    };
    jest.mocked(withCommitReporting).mockImplementationOnce((client) =>
      originalReporting(
        new Proxy(client, {
          get(target, key, receiver) {
            const value: unknown = Reflect.get(target, key, receiver);
            if (key !== '$transaction' || typeof value !== 'function') return value;
            return async (work: (tx: object) => Promise<unknown>, ...options: unknown[]) => {
              let hold = false;
              const result: unknown = await Reflect.apply(value, target, [
                async (tx: object) => {
                  const result = await work(tx);
                  hold = armed && !apiHold && !sourceHold;
                  if (hold) armed = false;
                  return hold && phase === 'precommit' ? wait(result) : result;
                },
                ...options,
              ]);
              return hold && phase !== 'precommit' ? wait(result) : result;
            };
          },
        }),
      ),
    );
    const prisma = newPrisma();
    const wiring = wire(prisma);
    const sources = new FakeSourceFacts();
    const sourceReference = `USG_${ulid()}`;
    const user = `USR_${ulid()}`;
    const payload = {
      usageRecordId: sourceReference,
      assetId: `AST_${ulid()}`,
      organizationId: org.a,
      hours: '8',
    };
    sources.recorded(payload, { recordedAt: new Date().toISOString(), recordedBy: user });
    if (sourceHold) {
      const lookup = sources.usageRecord.bind(sources);
      jest
        .spyOn(sources, 'usageRecord')
        .mockImplementationOnce(async (...args) => wait(await lookup(...args)));
    }
    const event = {
      eventId: ulid(),
      eventName: 'USAGE_RECORDED',
      tenantId: org.a,
      correlationId: ulid(),
      payload,
    } as EventEnvelope;
    let registered!: (e: EventEnvelope) => Promise<HandlerOutcome>;
    const make = () =>
      new RewardTriggerConsumer(
        (handler) => {
          registered = handler;
          return { stop: async () => undefined } as unknown as EventConsumer;
        },
        prisma,
        wiring.rewards,
        sources,
      );
    try {
      await prisma.onModuleInit();
      await runUnscoped('operator cutover for fresh verified fixtures', () =>
        recordCutoverIfMissing(prisma.client, new Date('2021-01-01T00:00:00Z')),
      );
      await asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
        wiring.rewards.createRule(
          {
            organizationId: org.a,
            triggerEvent: 'USAGE_RECORDED',
            rewardType: 'POINTS',
            status: 'ACTIVE',
            points: 1,
            creditPerPointMinor: '1',
            validFrom: '2010-01-01T00:00:00Z',
          },
          unanswered(),
        ),
      );
      const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
      jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (...args) => {
        await enqueue(...args);
        if (args[1].eventName === 'REWARD_GRANTED') armed = true;
      });
      if (apiHold) {
        const grant = wiring.rewards.grantFor.bind(wiring.rewards);
        jest
          .spyOn(wiring.rewards, 'grantFor')
          .mockImplementationOnce(async (input) => wait(await grant(input)));
      }
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const counters = [rewardsGrantedTotal, journalsPostedTotal, ledgerEntriesTotal].map(
        (counter) => jest.spyOn(counter, 'inc'),
      );
      const failures = jest.spyOn(rewardGrantFailuresTotal, 'inc');
      const verified = jest.spyOn(sourceVerificationsTotal, 'inc');
      const consumer = make();
      running = entry === 'direct' ? consumer.handle(event) : registered(event);
      void running.catch(() => undefined);
      await started;
      // Neither the callback's completed writes nor a hidden COMMIT confirms success.
      for (const counter of counters) expect(counter).toHaveBeenCalledTimes(reported);
      const verifications = verified.mock.calls.length;
      await consumer.stop({ deadlineAt: Date.now() - 1 });
      await consumer.onApplicationShutdown();
      release();
      await expect(running).rejects.toBeInstanceOf(WorkerAbandonedError);
      expect(log).not.toHaveBeenCalled();
      expect(verified).toHaveBeenCalledTimes(verifications);
      for (const counter of counters) expect(counter).toHaveBeenCalledTimes(reported);
      expect(failures).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ABANDONED.*UNCONFIRMED/));
      await expect(consumer.handle(event)).rejects.toBeInstanceOf(WorkerAbandonedError);
      const committed = phase !== 'precommit' && !sourceHold;
      const inspect = () =>
        runUnscoped('inspect only this tenant and verified source', async () => ({
          grants: await prisma.client.reward.findMany({
            where: { organizationId: org.a, sourceReference },
          }),
          journals: await prisma.client.journal.count({ where: { organizationId: org.a } }),
        }));
      expect((await inspect()).grants).toHaveLength(committed ? 1 : 0);
      expect((await inspect()).journals).toBe(committed ? 1 : 0);
      // Recover using a new worker, then replay both envelope and fact identities.
      await make().handle(event);
      await make().handle(event);
      await make().handle({ ...event, eventId: ulid() });
      for (const counter of counters)
        expect(counter).toHaveBeenCalledTimes(reported + (committed ? 0 : 1));
      expect(log).toHaveBeenCalledTimes(committed ? 0 : 1);
      expect(failures).not.toHaveBeenCalled();
      const state = await inspect();
      expect(state.grants).toHaveLength(1);
      expect(state.grants[0]).toMatchObject({ organizationId: org.a, userId: user });
      expect(state.journals).toBe(1);
    } finally {
      release();
      await running?.catch(() => undefined);
      jest.restoreAllMocks();
      await cleanup(prisma, [org.a, org.b, org.c]);
      await prisma.stop();
    }
  });
});
