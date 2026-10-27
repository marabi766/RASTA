import 'reflect-metadata';
import { Logger, type InjectionToken } from '@nestjs/common';
import { AppModule, FENCE_PRISMA, SAMPLER_PRISMA } from '../app.module';
import { projectionCommandPools, tearDownProjectionCommand } from '../keycloak/projection.command';
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

const POOLS: Array<[string, () => PrismaService]> = [
  ['the service’s business pool', () => appPool(PrismaService)],
  ['the service’s fence pool', () => appPool(FENCE_PRISMA)],
  ['the service’s sampler pool', () => appPool(SAMPLER_PRISMA)],
  ['the command’s business pool', () => projectionCommandPools(URL).prisma],
  ['the command’s fence pool', () => projectionCommandPools(URL).fencePool],
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

/**
 * Far past any deadline here, so a slow runner never trips it (#458 r3 F8):
 * the close is shown bounded by returning while the engine's answer is still
 * held — which an unbounded disconnect never does — not by a tight wall-clock
 * figure. A close that waited for the answer loses this race, fast.
 */
const HUNG_MS = 10_000;

function settledBefore<T>(work: Promise<T>): Promise<T | 'hung'> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => resolve('hung'), HUNG_MS);
  });
  return Promise.race([work, hung]).finally(() => clearTimeout(timer));
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) await turn();
  if (!condition()) throw new Error('never happened');
}

describe('#458 r3 F2: one admission point per pool, and a close bounded end to end', () => {
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
      // Closing: nothing new is admitted, of any kind.
      await expect(pool.client.$executeRawUnsafe('SELECT 3')).rejects.toThrow(PoolClosedError);
      await expect(
        pool.client.$transaction([pool.client.$executeRawUnsafe('SELECT 4')]),
      ).rejects.toThrow(PoolClosedError);
      expect(() => pool.transaction(async () => undefined)).toThrow(PoolClosedError);
      expect(await pool.isHealthy()).toBe(false);

      const report = await settledBefore(closing);
      // Returned while the answer is still held: Prisma's disconnect is
      // still waiting for it, and the close did not wait with it.
      expect(engine.held).toHaveLength(1);
      expect(report).toEqual({ drained: false, unsettled: 1 });
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
      setTimeout(() => engine.release(), 30);

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
    const { prisma, fencePool } = projectionCommandPools(URL);
    const engine = holdAnswers(fencePool);
    holdAnswers(prisma);
    const batch = fencePool.client.$transaction([fencePool.client.$executeRawUnsafe('SELECT 1')]);
    void batch.catch(() => undefined);
    await until(() => engine.held.length === 1);

    const left = await settledBefore(
      tearDownProjectionCommand({ pools: [fencePool, prisma] }, Date.now() + 20),
    );

    // Returned with the answer still held: bounded, not waited out.
    expect(engine.held).toHaveLength(1);
    expect(left).toEqual({ recoveriesUnwinding: 0, transactionsUnsettled: 1, poolsAbandoned: 1 });
    engine.release();
    await batch;
  });
});
