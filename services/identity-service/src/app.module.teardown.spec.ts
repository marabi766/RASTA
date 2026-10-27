import 'reflect-metadata';
import { Logger, type InjectionToken } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OutboxPurgeScheduler, OutboxRelay, OutboxShutdown } from '@rasta/nest-common';
import { gate, modelledPool } from '../test/modelled-engine';
import { AppModule, ENV, FENCE_PRISMA, SAMPLER_PRISMA } from './app.module';
import type { IdentityRepository } from './identity/identity.repository';
import type { IdentityService } from './identity/identity.service';
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
 * block.
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
  options: { kafkaStop?: () => Promise<void>; sibling?: { stop(): Promise<void> } } = {},
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
      { provide: ENV, useValue: { SHUTDOWN_TIMEOUT_MS: 10_000 } },
      { provide: PrismaService, useValue: business.pool },
      { provide: FENCE_PRISMA, useValue: fence.pool },
      { provide: SAMPLER_PRISMA, useValue: sampler.pool },
      { provide: KeycloakWriteFences, useValue: fences },
      { provide: KeycloakProjector, useValue: projector },
      { provide: MembershipExpiryScanner, useValue: scanner },
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
    // each a fresh fence; the first one's COMMIT answer comes back in 100 ms.
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
    setTimeout(answer.open, 100);
  }
  return { moduleRef, log };
}

describe('#458 r2 F2: Nest closes every pool only after every worker that uses it returned', () => {
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

      await moduleRef.close();

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

    await expect(booted.moduleRef.close()).rejects.toThrow('Kafka disconnect failed');

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

    const left = await tearDownProjectionCommand(
      { projector: t.projector, pools: [t.fence.pool, t.business.pool] },
      Date.now() + 1_000,
    );

    expect(left).toEqual({ recoveriesUnwinding: 0, transactionsUnsettled: 0, poolsAbandoned: 0 });
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

    const left = await tearDownProjectionCommand(
      { projector: t.projector, pools: [t.fence.pool, t.business.pool] },
      Date.now() + 100,
    );
    answer.open();

    expect(left.recoveriesUnwinding).toBe(1);
    expect(left.transactionsUnsettled).toBe(1);
    // The projector waited the whole deadline out: no time was left for
    // either pool's disconnect, so neither reports drained.
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

    const outcome = await tearDownProjectionCommand(
      { projector: t.projector, pools: [failing, t.business.pool] },
      Date.now() + 5_000,
    ).then(
      () => 'resolved',
      (error: unknown) => {
        t.log.push('TEARDOWN REJECTED');
        return (error as Error).message;
      },
    );
    await writing;

    expect(outcome).toBe('disconnect failed');
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
