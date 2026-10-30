import 'reflect-metadata';
import { Logger, type InjectionToken } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OUTBOX_SHUTDOWN_RESERVE_MS } from '@rasta/config';
import { OutboxPurgeScheduler, OutboxRelay, OutboxShutdown } from '@rasta/nest-common';
import { gate, modelledPool } from '../test/modelled-engine';
import { onTheTestsClock, returnedBy, until } from '../test/test-clock';
import { COMMIT_RESERVE_MS } from './prisma/cancellation';
import { AppModule, ENV, FENCE_PRISMA, SAMPLER_PRISMA } from './app.module';
import type { IdentityRepository } from './identity/identity.repository';
import type { IdentityService } from './identity/identity.service';
import { RegistrationIntakeWorker } from './identity/registration-intake.worker';
import { MembershipExpiryScanner } from './identity/membership-expiry.scanner';
import type { KeycloakAdminClient } from './keycloak/keycloak.client';
import { KeycloakProjector } from './keycloak/keycloak.projector';
import { KeycloakFenceSampler } from './keycloak/keycloak-fence-sampler';
import { KeycloakProjectionConsumer } from './keycloak/keycloak-projection.consumer';
import { KeycloakWriteFences } from './keycloak/keycloak-write-fence';
import { tearDownProjectionCommand } from './keycloak/projection.command';
import { KEYCLOAK_PROJECTION_OUTCOMES } from './observability/keycloak-projection.metrics';
import { OutboxGauges } from './observability/outbox-gauges';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import type { ExtendedPrismaClient } from './prisma/prisma.service';
import { PrismaService } from './prisma/prisma.service';
import { SECURITY_EVENT_RELAY } from './security-events/security-event.relay';

/**
 * #458 r2 F2: one owner for the whole teardown, the pools included.
 *
 * Nest runs every provider's `onModuleDestroy` at once. While each pool had
 * its own, it disconnected beside `OutboxShutdown`, and the reviewer's run of
 * the installed destroy hook with the production classes over a modelled
 * database gave `DISCONNECT, BEGIN 1, SET, INSERT, COMMIT 1`. This closes a
 * real Nest application context — the installed hooks, the production
 * `OutboxShutdown` factory from AppModule's own metadata, the real worker
 * classes and `PrismaService` — over the modelled engine
 * (`test/modelled-engine.ts`), with each worker's COMMIT answer held, and
 * requires every pool's DISCONNECT to come after the last statement of every
 * worker: for the scanner's flush, the projection consumer's flush and a
 * recovery projection. The CLI's teardown, which has no Nest, is the last
 * block. Every deadline is on the test's clock (`test/test-clock.ts`, #910):
 * an answer a test schedules comes when the test moves the clock there, so
 * whether it came before a deadline never depends on the runner.
 */

interface FactoryProvider {
  provide: InjectionToken;
  inject?: InjectionToken[];
  useFactory: (...args: unknown[]) => unknown;
}

function appProvider(token: unknown): FactoryProvider {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];
  const found = providers.find(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      provider !== null &&
      (provider as { provide?: unknown }).provide === token,
  );
  if (!found) throw new Error(`AppModule does not provide ${String(token)}`);
  return found;
}

/** A business transaction that holds the user lock with all its budget left. */
const lockHolder = {
  $queryRaw: async () => [{ elapsed_ms: 0 }],
} as unknown as ExtendedPrismaClient;

const DATABASE_STEP = /^(BEGIN|SET|INSERT|COMMIT|ROLLBACK)/;
const stub = () => ({ stop: async () => undefined });

type Worker = 'scanner' | 'consumer' | 'recovery';

async function boot(
  worker: Worker,
  options: {
    kafkaStop?: () => Promise<void>;
    sibling?: { stop(): Promise<void> };
    shutdownMs?: number;
    answerMs?: number;
  } = {},
) {
  const log: string[] = [];
  const business = modelledPool('business', log);
  const fence = modelledPool('fence', log);
  const sampler = modelledPool('sampler', log);
  let now = 0;
  const fences = new KeycloakWriteFences(fence.pool, { monotonicNow: () => now });
  const projector = new KeycloakProjector(
    {} as IdentityRepository,
    { enabled: true } as KeycloakAdminClient,
    fences,
  );
  const scanner =
    worker === 'scanner'
      ? new MembershipExpiryScanner(
          {} as IdentityRepository,
          {} as IdentityService,
          { enabled: false, intervalSeconds: 60, batchSize: 50 },
          projector,
          fences,
        )
      : stub();
  const consumer =
    worker === 'consumer'
      ? new KeycloakProjectionConsumer(
          () =>
            ({
              start: async () => undefined,
              stop: options.kafkaStop ?? (async () => undefined),
            }) as never,
          projector,
        )
      : stub();

  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: ENV, useValue: { SHUTDOWN_TIMEOUT_MS: options.shutdownMs ?? 10_000 } },
      { provide: PrismaService, useValue: business.pool },
      { provide: FENCE_PRISMA, useValue: fence.pool },
      { provide: SAMPLER_PRISMA, useValue: sampler.pool },
      { provide: KeycloakWriteFences, useValue: fences },
      { provide: KeycloakProjector, useValue: projector },
      { provide: MembershipExpiryScanner, useValue: scanner },
      { provide: RegistrationIntakeWorker, useValue: stub() },
      { provide: KeycloakProjectionConsumer, useValue: consumer },
      { provide: OutboxRelay, useValue: stub() },
      { provide: OutboxPurgeScheduler, useValue: stub() },
      { provide: SECURITY_EVENT_RELAY, useValue: stub() },
      { provide: KeycloakFenceSampler, useValue: stub() },
      { provide: OutboxGauges, useValue: options.sibling ?? stub() },
      { provide: KafkaEventPublisher, useValue: stub() },
      // The production coordinator, as AppModule declares it.
      appProvider(OutboxShutdown),
    ],
  }).compile();
  await moduleRef.init();

  if (worker === 'recovery') {
    // A request's recovery projection (D-070 D): one business transaction
    // whose COMMIT is sent at once and answered 100 ms later.
    const answer = gate();
    business.steps.push({ commit: answer.opened });
    setTimeout(answer.open, 100);
    jest
      .spyOn(projector, 'project')
      .mockImplementation(() =>
        business.pool
          .transaction((tx) => tx.$executeRawUnsafe('SET LOCAL x = 1'))
          .then(() => KEYCLOAK_PROJECTION_OUTCOMES.PROJECTED),
      );
    (
      projector as unknown as { requestRecovery(userId: string, signal?: AbortSignal): void }
    ).requestRecovery('USR_TEARDOWN', undefined);
  } else {
    // Two writes still unanswered past their deadline: the stop's flush owes
    // each a fresh fence; the first one's COMMIT answer comes back in 100 ms
    // (or `answerMs`).
    for (let i = 0; i < 2; i++) {
      const attempt = await fences.open(lockHolder, {
        userId: `USR_TEARDOWN_${i}`,
        keycloakId: `kc-teardown-${i}`,
        operation: 'replace_attributes',
        timeoutMs: 10,
        settleSeconds: 1,
        transactionTimeoutMs: 1_000,
      });
      attempt.assertDispatchable();
    }
    now = 20;
    log.length = 0;
    const answer = gate();
    fence.steps.push({ commit: answer.opened });
    setTimeout(answer.open, options.answerMs ?? 100);
  }
  return { moduleRef, log, scanner, consumer };
}

describe('#458 r2 F2: Nest closes every pool only after every worker that uses it returned', () => {
  onTheTestsClock();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<[string, Worker, number]>([
    ['the expiry scanner’s flush of owed fences', 'scanner', 2],
    ['the projection consumer’s flush of owed fences', 'consumer', 2],
    ['a request’s recovery projection', 'recovery', 1],
  ])(
    '%s: no BEGIN, statement or COMMIT after any DISCONNECT, through the installed destroy hooks',
    async (_name, worker, commits) => {
      const { moduleRef, log } = await boot(worker);

      // The answer comes 100 ms into the shutdown budget. What the log holds
      // when the close itself returned (#912), not once the clock moved on.
      const startedAt = Date.now();
      let atReturn: string[] = [];
      const closed = await returnedBy(
        moduleRef.close().then(() => void (atReturn = [...log])),
        100,
      );
      // Returned once that answer came and the pools closed, not before.
      expect(closed).toMatchObject({ status: 'fulfilled', settledAt: startedAt + 100 });
      expect(log).toEqual(atReturn);

      // The worker's writes all reached the database: none was refused by a
      // pool already closing.
      expect(log.filter((step) => step.startsWith('COMMIT'))).toHaveLength(commits);
      // Every pool closed once, all after the last statement of any worker:
      // not the reviewer's "DISCONNECT, BEGIN 1, SET, INSERT, COMMIT 1".
      const firstDisconnect = log.findIndex((step) => step.startsWith('DISCONNECT'));
      const lastStatement = log.findLastIndex((step) => DATABASE_STEP.test(step));
      expect(firstDisconnect).toBeGreaterThan(lastStatement);
      expect(log.filter((step) => step.startsWith('DISCONNECT')).sort()).toEqual([
        'DISCONNECT business',
        'DISCONNECT fence',
        'DISCONNECT sampler',
      ]);
    },
  );

  it.each<[string, 'scanner' | 'consumer']>([
    ['the expiry scanner', 'scanner'],
    ['the projection consumer', 'consumer'],
  ])(
    '#912: %s’s stop returns only after the COMMIT its flush handed to the engine — answered after the flush’s window closed — and every DISCONNECT after that',
    async (_name, worker) => {
      // A 350 ms budget (what the coordinator is given, after its reserve):
      // the flush's window closes 100 ms in; its first COMMIT's answer comes
      // at 250 ms, before the deadline.
      const booted = await boot(worker, {
        shutdownMs: OUTBOX_SHUTDOWN_RESERVE_MS + COMMIT_RESERVE_MS + 100,
        answerMs: 100 + 150,
      });
      const { log } = booted;
      // The worker's stop, as the coordinator calls it, logs its own return
      // (later calls join the first).
      const participant = booted[worker] as { stop(options: unknown): Promise<unknown> };
      const stop = participant.stop.bind(participant);
      let first: Promise<unknown> | undefined;
      jest.spyOn(participant, 'stop').mockImplementation((options) => {
        first ??= stop(options).then((value) => {
          log.push('WORKER RETURNED');
          return value;
        });
        return first;
      });
      const startedAt = Date.now();

      const closed = await returnedBy(booted.moduleRef.close(), COMMIT_RESERVE_MS + 100);

      expect(closed).toMatchObject({ status: 'fulfilled', settledAt: startedAt + 250 });
      // Not "BEGIN, SET, INSERT, WORKER RETURNED, COMMIT": the stop waited.
      expect(log.slice(0, 5)).toEqual(['BEGIN 3', 'SET', 'INSERT', 'COMMIT 3', 'WORKER RETURNED']);
      expect(log.slice(5).sort()).toEqual([
        'DISCONNECT business',
        'DISCONNECT fence',
        'DISCONNECT sampler',
      ]);
    },
  );

  it('#458 r3 F7, the reviewer’s trace: Kafka’s disconnect rejects while a sibling worker still drains — DISCONNECT only after WORKER FINISHED, and the consumer still flushed what it owed', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let log: string[] = [];
    const booted = await boot('consumer', {
      kafkaStop: async () => {
        log.push('STOP REJECTED');
        throw new Error('Kafka disconnect failed');
      },
      sibling: {
        stop: () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              log.push('WORKER FINISHED');
              resolve();
            }, 150),
          ),
      },
    });
    log = booted.log;

    // The sibling finishes 150 ms into the shutdown budget. What the log
    // holds when the close itself rejected (#912), not once the clock moved.
    const startedAt = Date.now();
    let atReturn: string[] = [];
    const closed = await returnedBy(
      booted.moduleRef.close().catch((error: unknown) => {
        atReturn = [...log];
        throw error;
      }),
      150,
    );
    // Rejected once the sibling finished and the pools closed, not before.
    expect(closed).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'Kafka disconnect failed' }),
      settledAt: startedAt + 150,
    });
    expect(log).toEqual(atReturn);

    const firstDisconnect = log.findIndex((step) => step.startsWith('DISCONNECT'));
    expect(log.indexOf('STOP REJECTED')).toBeGreaterThan(-1);
    expect(log.indexOf('WORKER FINISHED')).toBeGreaterThan(log.indexOf('STOP REJECTED'));
    expect(firstDisconnect).toBeGreaterThan(log.indexOf('WORKER FINISHED'));
    // The consumer's recovery ran despite the rejection: both owed fences
    // were written, before any pool closed.
    expect(log.filter((step) => step.startsWith('COMMIT'))).toHaveLength(2);
    expect(firstDisconnect).toBeGreaterThan(log.findLastIndex((step) => DATABASE_STEP.test(step)));
    expect(log.filter((step) => step.startsWith('DISCONNECT')).sort()).toEqual([
      'DISCONNECT business',
      'DISCONNECT fence',
      'DISCONNECT sampler',
    ]);
  });

  it('the production pool class has no destroy hook of its own for Nest to run beside the coordinator', () => {
    expect('onModuleDestroy' in PrismaService.prototype).toBe(false);
  });
});

describe('#458 r2 F2: the projection command’s teardown', () => {
  onTheTestsClock();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function command() {
    const log: string[] = [];
    const business = modelledPool('business', log);
    const fence = modelledPool('fence', log);
    const fences = new KeycloakWriteFences(fence.pool);
    const projector = new KeycloakProjector(
      {} as IdentityRepository,
      { enabled: true } as KeycloakAdminClient,
      fences,
    );
    jest
      .spyOn(projector, 'project')
      .mockImplementation(() =>
        business.pool
          .transaction((tx) => tx.$executeRawUnsafe('SET LOCAL x = 1'))
          .then(() => KEYCLOAK_PROJECTION_OUTCOMES.PROJECTED),
      );
    const recover = () =>
      (
        projector as unknown as { requestRecovery(userId: string, signal?: AbortSignal): void }
      ).requestRecovery('USR_COMMAND', undefined);
    return { log, business, fence, projector, recover };
  }

  it('a recovery whose COMMIT is in flight is waited for: COMMIT, then both DISCONNECTs; clean', async () => {
    const t = command();
    const answer = gate();
    t.business.steps.push({ commit: answer.opened });
    t.recover();
    // Its callback resolved: the COMMIT is with the engine, answered in 100 ms.
    await new Promise((resolve) => setImmediate(resolve));
    setTimeout(answer.open, 100);

    const startedAt = Date.now();
    const left = await returnedBy(
      tearDownProjectionCommand(
        { projector: t.projector, pools: [t.fence.pool, t.business.pool] },
        startedAt + 1_000,
      ).then((counts) => {
        t.log.push('TEARDOWN RETURNED');
        return counts;
      }),
      100,
    );

    // Returned once the answer came, not before it.
    expect(left).toEqual({
      status: 'fulfilled',
      value: { recoveriesUnwinding: 0, transactionsUnsettled: 0, poolsAbandoned: 0 },
      settledAt: startedAt + 100,
    });
    expect(t.log.pop()).toBe('TEARDOWN RETURNED');
    expect(t.log.slice(0, 3)).toEqual(['BEGIN 1', 'SET', 'COMMIT 1']);
    expect(t.log.slice(3).sort()).toEqual(['DISCONNECT business', 'DISCONNECT fence']);
  });

  it('#912: a recovery that gave up on its cancellation, its COMMIT still with the engine, is waited for: COMMIT, then both DISCONNECTs; clean', async () => {
    const t = command();
    const answer = gate();
    t.business.steps.push({ commit: answer.opened });
    // Its transaction's callback resolved — the COMMIT is with the engine —
    // and the projection itself ends on its cancellation, before that answer.
    jest.spyOn(t.projector, 'project').mockImplementation(
      (_userId, _trigger, options) =>
        new Promise((_resolve, reject) => {
          void t.business.pool.transaction((tx) => tx.$executeRawUnsafe('SET LOCAL x = 1'));
          const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        }),
    );
    t.recover();
    await until(() => t.log.includes('SET'));
    setTimeout(answer.open, 100);

    const startedAt = Date.now();
    const left = await returnedBy(
      tearDownProjectionCommand(
        { projector: t.projector, pools: [t.fence.pool, t.business.pool] },
        startedAt + 1_000,
      ),
      100,
    );

    // Not "unwinding 1" at once: the recovery's COMMIT was waited for.
    expect(left).toEqual({
      status: 'fulfilled',
      value: { recoveriesUnwinding: 0, transactionsUnsettled: 0, poolsAbandoned: 0 },
      settledAt: startedAt + 100,
    });
    expect(t.log.slice(0, 3)).toEqual(['BEGIN 1', 'SET', 'COMMIT 1']);
    expect(t.log.slice(3).sort()).toEqual(['DISCONNECT business', 'DISCONNECT fence']);
  });

  it('one whose COMMIT has not come back by the deadline is counted — the command is unclean, never "drained"', async () => {
    const t = command();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const answer = gate();
    t.business.steps.push({ commit: answer.opened });
    t.recover();
    await new Promise((resolve) => setImmediate(resolve));

    const deadlineAt = Date.now() + 100;
    const { settledAt, ...settled } = await returnedBy(
      tearDownProjectionCommand(
        { projector: t.projector, pools: [t.fence.pool, t.business.pool] },
        deadlineAt,
      ),
      100,
    );
    answer.open();

    // At the deadline, not before: it waited for the COMMIT until then.
    expect(settledAt).toBe(deadlineAt);
    if (settled.status !== 'fulfilled') throw settled.reason;
    const left = settled.value;
    expect(left.recoveriesUnwinding).toBe(1);
    expect(left.transactionsUnsettled).toBe(1);
    // The projector waited the whole deadline out: the clock is exactly at
    // it, on any runner, and no time was left for either pool's disconnect.
    // Each pool's own outcome (#910): the business pool, its COMMIT still
    // unanswered, and the idle fence pool, both abandoned — neither drained.
    expect(await t.business.pool.stop()).toEqual({ drained: false, unsettled: 1 });
    expect(await t.fence.pool.stop()).toEqual({ drained: false, unsettled: 0 });
    expect(left.poolsAbandoned).toBe(2);
  });

  it('#458 r3 F7: one pool whose close fails never ends the wait for its sibling — the failure comes only after the other pool’s COMMIT and DISCONNECT', async () => {
    const t = command();
    const answer = gate();
    t.business.steps.push({ commit: answer.opened });
    // A transaction admitted on the business pool, its COMMIT with the
    // engine, answered in 100 ms.
    const writing = t.business.pool.transaction((tx) => tx.$executeRawUnsafe('SET LOCAL x = 1'));
    await new Promise((resolve) => setImmediate(resolve));
    setTimeout(answer.open, 100);
    const failing = {
      stop: async () => {
        t.log.push('FENCE POOL CLOSE REJECTED');
        throw new Error('disconnect failed');
      },
    };

    const startedAt = Date.now();
    const outcome = await returnedBy(
      tearDownProjectionCommand(
        { projector: t.projector, pools: [failing, t.business.pool] },
        Date.now() + 5_000,
      ).then(
        () => 'resolved',
        (error: unknown) => {
          t.log.push('TEARDOWN REJECTED');
          return (error as Error).message;
        },
      ),
      100,
    );
    await writing;

    // Rejected once the other pool's COMMIT came, not before it.
    expect(outcome).toEqual({
      status: 'fulfilled',
      value: 'disconnect failed',
      settledAt: startedAt + 100,
    });
    expect(t.log).toEqual([
      'BEGIN 1',
      'SET',
      'FENCE POOL CLOSE REJECTED',
      'COMMIT 1',
      'DISCONNECT business',
      'TEARDOWN REJECTED',
    ]);
  });

  it('#458 r3 F7: a projector whose stop fails still has both pools closed after it, then the failure', async () => {
    const t = command();
    jest.spyOn(t.projector, 'stop').mockRejectedValue(new Error('projector stop failed'));

    await expect(
      tearDownProjectionCommand(
        { projector: t.projector, pools: [t.fence.pool, t.business.pool] },
        Date.now() + 5_000,
      ),
    ).rejects.toThrow('projector stop failed');
    expect(t.log.sort()).toEqual(['DISCONNECT business', 'DISCONNECT fence']);
  });
});
