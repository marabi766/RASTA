import {
  SessionTimeZoneRefusedError,
  preflightRuntimeRole,
  withinDeadline,
} from '@rasta/nest-common';
import { withUtcSession } from '@rasta/config';
import { ulid } from 'ulid';
import { Prisma, PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl } from './helpers';

/**
 * A session outside UTC is refused on the backend that runs the work (FU-188).
 *
 * One connection in the pool, so a `SET` reaches the backend every later
 * operation runs on, whichever way it comes: exactly what a transaction-pooling
 * PgBouncer can hand a client after the boot check passed. The boot check itself
 * is in nest-common's runtime-role.spec.ts.
 */
describe('a database session outside UTC (FU-188)', () => {
  let db: PrismaService;
  const scope = `utc_session_${ulid().toLowerCase()}`;

  const toZone = (zone: string) =>
    db.client.$transaction(async (tx) => {
      // Reaches past the commit, the way a backend keeps a leaked SET.
      await tx.$executeRawUnsafe(`SELECT set_config('TimeZone', '${zone}', false)`);
    });
  const backToUtc = () =>
    // Not through the checked boundary: that would refuse it.
    (db as unknown as { base: { $connect(): Promise<void>; $disconnect(): Promise<void> } }).base
      .$disconnect()
      .then(() => db.onModuleInit());
  const seed = (id: string) =>
    db.client.registrationIntake.create({
      data: { id, submission: { scope }, actorType: 'ANONYMOUS', correlationId: id },
    });
  const count = () =>
    db.client.registrationIntake.count({
      where: { submission: { path: ['scope'], equals: scope } },
    });

  beforeAll(async () => {
    const url = new URL(withUtcSession(databaseUrl()));
    url.searchParams.set('connection_limit', '1');
    db = new PrismaService(url.toString());
    await db.onModuleInit();
  });
  afterEach(async () => {
    await backToUtc();
    await db.client.registrationIntake.deleteMany({
      where: { submission: { path: ['scope'], equals: scope } },
    });
  });
  afterAll(() => db.stop());

  const WRITES: ReadonlyArray<[string, (id: string) => PromiseLike<unknown>]> = [
    [
      'an autocommit raw write',
      (id) =>
        db.client
          .$executeRaw`INSERT INTO registration_intake (id, submission, actor_type, correlation_id)
        VALUES (${id}, ${JSON.stringify({ scope })}::jsonb, 'ANONYMOUS', ${id})`,
    ],
    ['an autocommit model write', (id) => seed(id)],
    [
      'an interactive transaction',
      (id) =>
        db.transaction(async (tx) => {
          await tx.registrationIntake.create({
            data: { id, submission: { scope }, actorType: 'ANONYMOUS', correlationId: id },
          });
        }),
    ],
    [
      'a batch transaction',
      (id) =>
        db.client.$transaction([
          db.client.registrationIntake.create({
            data: { id, submission: { scope }, actorType: 'ANONYMOUS', correlationId: id },
          }),
        ]),
    ],
  ];

  it.each(WRITES)('%s runs in UTC and returns what it returned', async (_, write) => {
    await write(ulid());
    expect(await count()).toBe(1);
  });

  it('a batch answers only its own statements', async () => {
    const id = ulid();
    const [created, counted] = await db.client.$transaction([
      db.client.registrationIntake.create({
        data: { id, submission: { scope }, actorType: 'ANONYMOUS', correlationId: id },
      }),
      db.client.registrationIntake.count({ where: { id } }),
    ]);
    expect(created.id).toBe(id);
    expect(counted).toBe(1);
  });

  it.each(['Asia/Tehran', 'America/Los_Angeles', 'Etc/UTC', 'GMT'])(
    'after the backend moved to %s, every write is refused and writes nothing',
    async (zone) => {
      await toZone(zone);
      for (const [, write] of WRITES) {
        await expect(write(ulid())).rejects.toBeInstanceOf(SessionTimeZoneRefusedError);
      }
      await backToUtc();
      expect(await count()).toBe(0);
    },
  );

  it('an autocommit raw read is refused too, and readiness says so', async () => {
    await toZone('Asia/Tehran');
    await expect(db.client.$queryRaw`SELECT 1 AS one`).rejects.toBeInstanceOf(
      SessionTimeZoneRefusedError,
    );
    expect(await db.isHealthy()).toBe(false);
  });

  it('a plain model read is left alone: the session zone does not reach it', async () => {
    const id = ulid();
    const at = new Date('2030-01-02T03:04:05.678Z');
    await db.client.registrationIntake.create({
      data: {
        id,
        submission: { scope },
        actorType: 'ANONYMOUS',
        correlationId: id,
        receivedAt: at,
      },
    });
    await toZone('Asia/Tehran');
    const row = await db.client.registrationIntake.findFirstOrThrow({
      where: { id, receivedAt: { lte: at } },
    });
    expect(row.receivedAt).toEqual(at);
  });

  it('the refusal carries no driver text', async () => {
    await toZone('Asia/Tehran');
    const refusal = await seed(ulid()).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(refusal).toBeInstanceOf(SessionTimeZoneRefusedError);
    expect(refusal?.message).not.toMatch(/invalid input|Tehran|P2010/);
  });

  it('a service whose connection comes up outside UTC refuses to start and to work', async () => {
    const url = new URL(databaseUrl());
    url.searchParams.set('options', '-c TimeZone=Asia/Tehran');
    const outside = new PrismaService(url.toString());
    await outside.onModuleInit();
    try {
      // main.ts: the preflight, on a client of its own, names the zone.
      await expect(
        preflightRuntimeRole(
          () => new PrismaClient({ datasources: { db: { url: url.toString() } } }),
          { service: 'identity-service', runtimeVariable: 'DATABASE_URL_IDENTITY' },
        ),
      ).rejects.toThrow(/Asia\/Tehran, not UTC/);
      // AppModule: on the service's own client, the session check answers first.
      await expect(outside.assertRuntimeRole()).rejects.toBeInstanceOf(SessionTimeZoneRefusedError);
      await expect(outside.client.$queryRaw`SELECT 1`).rejects.toBeInstanceOf(
        SessionTimeZoneRefusedError,
      );
    } finally {
      await outside.stop();
    }
  });

  describe('no exposed client runs without the check (PR #906 r1 F1, on a real backend)', () => {
    const insert = (client: { $executeRawUnsafe: PrismaClient['$executeRawUnsafe'] }, id: string) =>
      client.$executeRawUnsafe(
        `INSERT INTO registration_intake (id, submission, actor_type, correlation_id)
         VALUES ($1, $2::jsonb, 'ANONYMOUS', $1)`,
        id,
        JSON.stringify({ scope }),
      );
    const afterRefusal = async () => {
      await backToUtc();
      expect(await count()).toBe(0);
    };

    it('$parent is refused, on a client and on a model', async () => {
      await toZone('Asia/Tehran');
      const client = db.client as unknown as { $parent: PrismaClient };
      const model = db.client.registrationIntake as unknown as { $parent: PrismaClient };
      expect(() => client.$parent).toThrow(/refused/);
      expect(() => model.$parent).toThrow(/refused/);
      await afterRefusal();
    });

    it('the function form of $extends is refused', async () => {
      await toZone('Asia/Tehran');
      let captured: PrismaClient | undefined;
      const form = (client: PrismaClient) => {
        captured = client;
        return client;
      };
      expect(() => (db.client.$extends as (extension: unknown) => unknown)(form)).toThrow(
        /refused/,
      );
      expect(captured).toBeUndefined();
      await afterRefusal();
    });

    it('a statement in a batch of a client without the check is refused, also in UTC', async () => {
      const bare = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
      try {
        await expect(bare.$transaction([insert(db.client, ulid())])).rejects.toThrow(/refused/);
      } finally {
        await bare.$disconnect();
      }
      expect(await count()).toBe(0);
    });

    it('a client method of an extension is refused like any other statement', async () => {
      const extended = db.client.$extends({
        client: {
          write(id: string) {
            const self = Prisma.getExtensionContext(this) as unknown as PrismaClient;
            return self.$transaction((tx) =>
              insert(tx as unknown as Pick<PrismaClient, '$executeRawUnsafe'>, id),
            );
          },
        },
      });
      await toZone('Asia/Tehran');
      await expect(extended.write(ulid())).rejects.toBeInstanceOf(SessionTimeZoneRefusedError);
      await afterRefusal();
    });
  });

  it('a service in UTC passes the boot check', async () => {
    await expect(db.assertRuntimeRole()).resolves.toBeUndefined();
  });

  it('a refused batch does not leave the pool waiting', async () => {
    await toZone('Asia/Tehran');
    await expect(seed(ulid())).rejects.toBeInstanceOf(SessionTimeZoneRefusedError);
    await backToUtc();
    expect(await withinDeadline(db.client.$queryRaw`SELECT 1`, 5000)).toBe('finished');
  });
});
