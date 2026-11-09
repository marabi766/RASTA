import { withStatementTimeout } from '@rasta/config';
import { boundedReleaseSql, purgePublishedSql, renewSql } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { pooledFenceSampleSource } from '../src/keycloak/keycloak-fence-sampler';
import { PrismaService, type ExtendedPrismaClient } from '../src/prisma/prisma.service';
import type { SecurityEventRecord } from '../src/security-events/audit-trail-envelope';
import { SecurityEventOutboxStore } from '../src/security-events/security-event-outbox.store';
import { databaseUrl } from './helpers';

const TIMEOUT_MS = 1234;
const ROLLBACK = new Error('intentional settings rollback');
const SETTINGS = `SELECT current_setting('statement_timeout') AS statement,
  current_setting('lock_timeout') AS lock, pg_backend_pid() AS pid`;
type Settings = { statement: string; lock: string; pid: number };

// The SAME physical connection must be reused after COMMIT and ROLLBACK.
// Session defaults differ from every local value, so a missing/false LOCAL flag fails.
describe('bound SQL settings retain transaction-local scope (FU-290)', () => {
  const pool = new PrismaService(withStatementTimeout(databaseUrl(), 17_000), { connections: 1 });
  const original = pool.transaction.bind(pool);
  const holder = new PrismaService(databaseUrl(), { connections: 1 });
  const read = async (tx: Pick<ExtendedPrismaClient, '$queryRawUnsafe'>): Promise<Settings> =>
    (await tx.$queryRawUnsafe<Settings[]>(SETTINGS))[0]!;
  let baseline: Settings;

  beforeAll(async () => {
    await pool.onModuleInit();
    await holder.onModuleInit();
    await holder.client.$executeRawUnsafe('SELECT pg_advisory_lock(1318)');
    // Keep the scope probe from deleting any other suite's public fixtures.
    await holder.client.$executeRawUnsafe(
      "SELECT pg_advisory_lock(hashtext('rasta.outbox_purge'), hashtext(current_schema()))",
    );
    await pool.client.$executeRawUnsafe("SET lock_timeout = '19s'");
    baseline = await read(pool.client);
    expect(baseline).toMatchObject({ statement: '17s', lock: '19s' });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await holder.client.$executeRawUnsafe('SELECT pg_advisory_unlock_all()');
    await holder.stop();
    await pool.stop();
  });

  const run = <T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> =>
    pool.transaction(fn, { timeout: 20_000 });
  const source = pooledFenceSampleSource(pool, new IdentityRepository(pool));
  const sites: Array<[string, 'statement' | 'lock', () => Promise<unknown>]> = [
    [
      'Prisma transaction',
      'statement',
      () => pool.transaction(async () => 0, { statementTimeoutMs: TIMEOUT_MS }),
    ],
    ['fence sampler', 'lock', () => source.fences(TIMEOUT_MS)],
    ['lapse sampler', 'lock', () => source.lapseBacklog(TIMEOUT_MS)],
    [
      'bounded release',
      'statement',
      () => boundedReleaseSql(run, { remainingMs: () => TIMEOUT_MS }, async () => 0),
    ],
    ['renew', 'statement', () => renewSql(run, ['absent'], 'token', 60, TIMEOUT_MS)],
    [
      'purge',
      'statement',
      () =>
        purgePublishedSql(run, {
          retentionSeconds: 3600,
          limit: 1,
          statementTimeoutMs: TIMEOUT_MS,
          maxWaitMs: 1000,
        }),
    ],
  ];

  describe.each(sites)('%s', (_name, setting, operation) => {
    it.each(['commit', 'rollback', 'timeout'] as const)(
      'resets after %s on the same connection',
      async (end) => {
        let observed = false;
        jest.spyOn(pool, 'transaction').mockImplementation((fn, options) =>
          original(
            async (tx) => {
              const result = await fn(tx);
              const local = await read(tx);
              expect(local.pid).toBe(baseline.pid);
              expect(local[setting]).toBe(`${TIMEOUT_MS}ms`);
              observed = true;
              if (end === 'rollback') throw ROLLBACK;
              if (end === 'timeout') {
                // Separate lock_timeout from statement_timeout for the samplers.
                if (setting === 'lock') {
                  await tx.$executeRawUnsafe(
                    "SELECT pg_catalog.set_config('statement_timeout', '17s', true)",
                  );
                  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(1318)');
                } else await tx.$executeRawUnsafe('SELECT pg_sleep(2)');
              }
              return result;
            },
            { ...options, budgetMs: undefined, timeout: 20_000 },
          ),
        );
        if (end === 'commit') await operation();
        else if (end === 'rollback') await expect(operation()).rejects.toBe(ROLLBACK);
        else
          await expect(operation()).rejects.toMatchObject({
            meta: { code: setting === 'lock' ? '55P03' : '57014' },
          });
        expect(observed).toBe(true);
        expect(await read(pool.client)).toEqual(baseline);
      },
    );
  });

  it.each(['commit', 'rollback', 'timeout'] as const)(
    'capture batch resets after %s',
    async (end) => {
      const id = ulid();
      const draft: SecurityEventRecord = {
        id,
        organizationId: null,
        actorType: 'SYSTEM',
        actorId: id,
        actorRoles: [],
        action: 'test.settings',
        resourceType: 'Test',
        resourceId: id,
        errorCode: 'FORBIDDEN',
        reason: null,
        sourceIp: null,
        sourceUserAgent: null,
        correlationId: id,
        traceparent: null,
        producerVersion: 'test',
        occurredAt: new Date(),
        occurrenceCount: 1,
      };
      // Preserve lazy PrismaPromises and the real batch transaction; append a read
      // before COMMIT, or a database error to force the batch's ROLLBACK.
      const client = pool.client;
      type Batch = { $transaction(queries: PromiseLike<unknown>[]): Promise<unknown[]> };
      const batch = client as unknown as Batch;
      const transaction = batch.$transaction.bind(client);
      const captureClient = new Proxy(client, {
        get(target, key) {
          if (key !== '$transaction') return Reflect.get(target, key, target);
          return async (queries: PromiseLike<unknown>[]) => {
            const rows = await transaction([
              ...queries,
              client.$queryRawUnsafe(SETTINGS),
              ...(end === 'rollback' ? [client.$executeRawUnsafe('SELECT 1 / 0')] : []),
              ...(end === 'timeout' ? [client.$executeRawUnsafe('SELECT pg_sleep(2)')] : []),
            ]);
            expect(rows[2]).toEqual([{ ...baseline, statement: `${TIMEOUT_MS}ms` }]);
            return rows;
          };
        },
      });
      const local = new Proxy(pool, {
        get(target, key) {
          return key === 'client' ? captureClient : Reflect.get(target, key, target);
        },
      });
      try {
        const capture = new SecurityEventOutboxStore(local).capture(draft, {
          timeoutMs: TIMEOUT_MS,
          windowSeconds: 1,
        });
        if (end !== 'commit')
          await expect(capture).rejects.toMatchObject({
            meta: { code: end === 'rollback' ? '22012' : '57014' },
          });
        else await capture;
        expect(await read(client)).toEqual(baseline);
        expect(await client.securityEventOutbox.count({ where: { id } })).toBe(
          end === 'commit' ? 1 : 0,
        );
      } finally {
        await client.securityEventOutbox.deleteMany({ where: { id } });
      }
    },
  );
});
