import 'reflect-metadata';
import { Logger, type InjectionToken } from '@nestjs/common';
import { AppModule, FENCE_PRISMA, SAMPLER_PRISMA } from '../app.module';
import {
  PROJECTION_COMMAND_POOLS,
  tearDownProjectionCommand,
} from '../keycloak/projection.command';
import { onTheTestsClock, until, watch } from '../../test/test-clock';
import { PoolClosedError, PrismaService } from './prisma.service';

/**
 * #458 r3 F2: every database operation is admitted at one point per pool and
 * accounted for, and the pool's close is bounded end to end.
 *
 * Held to the **real** Prisma client — its query extensions, its batch
 * `$transaction([...])`, its request handler — and its real engine wrapper
 * (`LibraryEngine`), whose `$disconnect` waits for the query it is executing.
 * Only the native query engine under it is replaced, by one whose answers
 * the test holds and releases: the reviewer's probe, which the modelled
 * engine (`test/modelled-engine.ts`, an immediate DISCONNECT, no extension)
 * cannot express. Every pool the service and the projection command open, as
 * they open them: AppModule's three factories and the command's two.
 *
 * Every deadline here is on the test's clock (`test/test-clock.ts`, #910): no
 * outcome depends on how fast the runner is.
 */

const URL = 'postgresql://probe:probe@127.0.0.1:1/probe?schema=public';

interface FactoryProvider {
  provide: InjectionToken;
  useFactory: (...args: unknown[]) => unknown;
}

function appPool(token: InjectionToken): PrismaService {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as FactoryProvider[];
  const found = providers.find((provider) => provider?.provide === token);
  if (!found) throw new Error(`AppModule does not provide ${String(token)}`);
  return found.useFactory({ DATABASE_URL: URL }) as PrismaService;
}

/** The command's pools, as `projection.cli.ts` opens them. */
function commandPools() {
  return {
    prisma: new PrismaService(URL, PROJECTION_COMMAND_POOLS.prisma),
    fencePool: new PrismaService(URL, PROJECTION_COMMAND_POOLS.fencePool),
  };
}

const POOLS: Array<[string, () => PrismaService]> = [
  ['the service’s business pool', () => appPool(PrismaService)],
  ['the service’s fence pool', () => appPool(FENCE_PRISMA)],
  ['the service’s sampler pool', () => appPool(SAMPLER_PRISMA)],
  ['the command’s business pool', () => commandPools().prisma],
  ['the command’s fence pool', () => commandPools().fencePool],
];

interface NativeEngine {
  query(body: string, headers: string, transactionId?: string): Promise<string>;
  startTransaction(options: string, headers: string): Promise<string>;
  commitTransaction(id: string, headers: string): Promise<string>;
  rollbackTransaction(id: string, headers: string): Promise<string>;
  disconnect(headers: string): Promise<void>;
}

/** Prisma's real engine wrapper over a native engine whose every answer is held. */
function holdAnswers(pool: PrismaService) {
  const engine = (pool as unknown as { base: { _engine: Record<string, unknown> } }).base._engine;
  const held: Array<{ body: string; answer: (response: string) => void }> = [];
  const log: string[] = [];
  const native: NativeEngine = {
    query: (body) => new Promise<string>((answer) => held.push({ body, answer })),
    startTransaction: async () => (log.push('BEGIN'), JSON.stringify({ id: 'itx-1' })),
    commitTransaction: async () => (log.push('COMMIT'), '{}'),
    rollbackTransaction: async () => (log.push('ROLLBACK'), '{}'),
    disconnect: async () => void log.push('DISCONNECT'),
  };
  // Started, over the held engine: no library is loaded, no database reached.
  Object.assign(engine, {
    libraryInstantiationPromise: Promise.resolve(),
    libraryStarted: true,
    engine: native,
  });
  return {
    held,
    log,
    /** Answers every held query: each statement of a batch, or the one statement. */
    release() {
      for (const { body, answer } of held.splice(0)) {
        const request = JSON.parse(body) as { batch?: unknown[] };
        answer(
          JSON.stringify(
            request.batch
              ? { batchResult: request.batch.map(() => ({ data: { executeRaw: 1 } })) }
              : { data: { executeRaw: 1 } },
          ),
        );
      }
    },
  };
}

const admitted = (pool: PrismaService) =>
  (pool as unknown as { admitted: Set<unknown> }).admitted.size;

const turn = () => new Promise((resolve) => setImmediate(resolve));

describe('#458 r3 F2: one admission point per pool, and a close bounded end to end', () => {
  onTheTestsClock();

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(POOLS)('%s', (_name, open) => {
    it('the reviewer’s probe: a batch whose answer is held is tracked; a stop with a 20 ms deadline returns abandoned within its budget; new work while closing is refused', async () => {
      const pool = open();
      const engine = holdAnswers(pool);
      const batch = pool.client.$transaction([
        pool.client.$executeRawUnsafe('SELECT 1'),
        pool.client.$executeRawUnsafe('SELECT 2'),
      ]);
      void batch.catch(() => undefined);
      await until(() => engine.held.length === 1);
      // One batch, one entry — not the reviewer's "tracked=0".
      expect(admitted(pool)).toBe(1);

      const closing = pool.stop({ deadlineAt: Date.now() + 20 });
      const close = watch(closing);
      // Closing: nothing new is admitted, of any kind.
      await expect(pool.client.$executeRawUnsafe('SELECT 3')).rejects.toThrow(PoolClosedError);
      await expect(
        pool.client.$transaction([pool.client.$executeRawUnsafe('SELECT 4')]),
      ).rejects.toThrow(PoolClosedError);
      expect(() => pool.transaction(async () => undefined)).toThrow(PoolClosedError);
      expect(await pool.isHealthy()).toBe(false);

      // It waits for the batch until the deadline, not less ...
      await jest.advanceTimersByTimeAsync(19);
      expect(close.settled).toBe(false);
      // ... and returns once it passed, with the answer still held: Prisma's
      // disconnect is still waiting for it, and the close did not wait with it.
      await jest.advanceTimersByTimeAsync(1);
      await until(() => close.settled);
      expect(engine.held).toHaveLength(1);
      expect(await closing).toEqual({ drained: false, unsettled: 1 });
      expect(
        (Logger.prototype.error as jest.Mock).mock.calls.map(([message]) => String(message)),
      ).toEqual([
        expect.stringMatching(/with 1 operations unsettled/),
        expect.stringMatching(/close ABANDONED.*1 operations still unsettled/),
      ]);

      engine.release();
      await expect(batch).resolves.toEqual([1, 1]);
      expect(admitted(pool)).toBe(0);
    });

    it('an autocommit statement admitted before the close is waited for: answered, then disconnected, drained', async () => {
      const pool = open();
      const engine = holdAnswers(pool);
      // Awaited, as every caller does: a Prisma promise starts only then.
      const statement = Promise.resolve(pool.client.$executeRawUnsafe('UPDATE probe SET x = 1'));
      await until(() => engine.held.length === 1);
      expect(admitted(pool)).toBe(1);

      const closing = pool.stop({ deadlineAt: Date.now() + 5_000 });
      const close = watch(closing);
      await turn();
      expect(close.settled).toBe(false);
      // Answered with the clock standing still: the deadline cannot pass first.
      engine.release();

      expect(await closing).toEqual({ drained: true, unsettled: 0 });
      await expect(statement).resolves.toBe(1);
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });
  });

  it('an interactive transaction admitted before the close drains: its next statement and its COMMIT still run while closing, then DISCONNECT', async () => {
    const pool = appPool(FENCE_PRISMA);
    const engine = holdAnswers(pool);
    const writing = pool.transaction(async (tx) => {
      await tx.$executeRawUnsafe('UPDATE probe SET x = 1');
      engine.log.push('SECOND STATEMENT');
      await tx.$executeRawUnsafe('UPDATE probe SET x = 2');
    });
    await until(() => engine.held.length === 1);

    const closing = pool.stop({ deadlineAt: Date.now() + 5_000 });
    // New work is refused; the transaction's own statements are not.
    await expect(pool.client.$executeRawUnsafe('SELECT 3')).rejects.toThrow(PoolClosedError);
    engine.release();
    await until(() => engine.held.length === 1);
    engine.release();

    expect(await closing).toEqual({ drained: true, unsettled: 0 });
    await writing;
    expect(engine.log).toEqual(['BEGIN', 'SECOND STATEMENT', 'COMMIT', 'DISCONNECT']);
  });

  it('a batch that never reaches the engine — a statement of it refused by the tenant guard — is not left tracked', async () => {
    const pool = appPool(PrismaService);
    holdAnswers(pool);
    await expect(
      pool.client.$transaction([
        pool.client.$executeRawUnsafe('SELECT 1'),
        // Tenant-scoped, outside any request: the guard refuses it.
        pool.client.membership.findMany(),
      ]),
    ).rejects.toThrow();
    await turn();
    expect(admitted(pool)).toBe(0);
    expect(await pool.stop({ deadlineAt: Date.now() + 1_000 })).toEqual({
      drained: true,
      unsettled: 0,
    });
  });

  it('the readiness probe in flight is admitted and waited for like any operation', async () => {
    const pool = appPool(SAMPLER_PRISMA);
    const engine = holdAnswers(pool);
    void pool.isHealthy();
    await until(() => engine.held.length === 1);
    expect(admitted(pool)).toBe(1);
    engine.release();
    await until(() => admitted(pool) === 0);
  });

  it('the command’s teardown over its real pools: a batch held past the deadline makes the run unclean, within its budget', async () => {
    const { prisma, fencePool } = commandPools();
    const engine = holdAnswers(fencePool);
    const idle = holdAnswers(prisma);
    const batch = fencePool.client.$transaction([fencePool.client.$executeRawUnsafe('SELECT 1')]);
    void batch.catch(() => undefined);
    await until(() => engine.held.length === 1);

    const tearingDown = tearDownProjectionCommand({ pools: [fencePool, prisma] }, Date.now() + 20);
    const teardown = watch(tearingDown);
    // Each pool's own outcome (#910), not only the count. The idle one
    // disconnects with the clock standing still — before the deadline, by
    // construction: drained. (On the real clock, a runner slow enough to let
    // 20 ms pass first made it abandoned too — correctly, and the count 2.)
    await until(() => idle.log.includes('DISCONNECT'));
    expect(await prisma.stop()).toEqual({ drained: true, unsettled: 0 });
    // The held one waits for its batch until the deadline ...
    expect(teardown.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(20);
    // ... and is abandoned once it passed, the answer still held: bounded,
    // not waited out.
    await until(() => teardown.settled);
    expect(engine.held).toHaveLength(1);
    expect(await fencePool.stop()).toEqual({ drained: false, unsettled: 1 });
    expect(await tearingDown).toEqual({
      recoveriesUnwinding: 0,
      transactionsUnsettled: 1,
      poolsAbandoned: 1,
    });
    engine.release();
    await batch;
  });
});
