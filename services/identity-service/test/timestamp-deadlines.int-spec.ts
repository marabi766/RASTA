import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { KeycloakWriteFences } from '../src/keycloak/keycloak-write-fence';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { PrismaService, type ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { SecurityEventOutboxStore } from '../src/security-events/security-event-outbox.store';
import { databaseUrl } from './helpers';

// Replace only clock sources: execute the production SQL and persist into the
// migrated TIMESTAMP(3) columns. Nonzero milliseconds kill second truncation.
const INSTANT = "TIMESTAMPTZ '2100-01-01T00:00:00.123927Z'";
const AT = Date.parse('2100-01-01T00:00:00.123Z');
const clock = (sql: string): string =>
  sql
    .replaceAll('clock_timestamp()', INSTANT)
    .replaceAll('now()', INSTANT)
    .replaceAll('statement_timestamp()', INSTANT);
const onClock = (client: ExtendedPrismaClient): ExtendedPrismaClient => {
  const execute = client.$executeRaw.bind(client);
  const queryUnsafe = client.$queryRawUnsafe.bind(client);
  const executeUnsafe = client.$executeRawUnsafe.bind(client);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === '$executeRaw') {
        return (query: TemplateStringsArray, ...values: unknown[]) => {
          if (!Array.isArray(query)) throw new Error('expected tagged SQL');
          const parts = query.map(clock);
          return execute(Object.assign(parts, { raw: parts }), ...values);
        };
      }
      if (property === '$queryRawUnsafe') {
        return <T>(sql: string, ...values: unknown[]) => queryUnsafe<T>(clock(sql), ...values);
      }
      if (property === '$executeRawUnsafe') {
        return (sql: string, ...values: unknown[]) => executeUnsafe(clock(sql), ...values);
      }
      return Reflect.get(target, property, receiver);
    },
  });
};

describe('TIMESTAMP(3) deadline bounds (FU-162, real PostgreSQL)', () => {
  let prisma: PrismaService;
  let pool: PrismaService;
  const schema = `timestamp_deadlines_${ulid().toLowerCase()}`;
  let owner: PrismaService;
  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL_IDENTITY_MIGRATOR;
    if (!ownerUrl)
      throw new Error('DATABASE_URL_IDENTITY_MIGRATOR is required for the isolated schema');
    owner = new PrismaService(ownerUrl);
    await owner.client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    // Copy the migrated columns, precision, CHECK constraints and indexes.
    for (const table of [
      'user',
      'keycloak_write_attempt',
      'outbox_message',
      'security_event_outbox',
    ]) {
      await owner.client.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    const url = new URL(databaseUrl());
    const role = decodeURIComponent(url.username).replaceAll('"', '""');
    await owner.client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await owner.client.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    );
    url.searchParams.set('schema', schema);
    prisma = new PrismaService(url.toString());
    pool = new PrismaService(url.toString());
    await prisma.onModuleInit();
    await pool.onModuleInit();
  });
  beforeEach(() => {
    for (const db of [prisma, pool]) {
      const transaction = db.transaction.bind(db);
      jest
        .spyOn(db, 'transaction')
        .mockImplementation((work, options) => transaction((tx) => work(onClock(tx)), options));
      const frozen = onClock(db.client);
      jest.spyOn(db.client, '$executeRaw').mockImplementation(frozen.$executeRaw);
      jest.spyOn(db.client, '$queryRawUnsafe').mockImplementation(frozen.$queryRawUnsafe);
      jest.spyOn(db.client, '$executeRawUnsafe').mockImplementation(frozen.$executeRawUnsafe);
    }
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await pool?.stop();
    await prisma?.stop();
    if (owner) {
      try {
        await owner.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await owner.stop();
      }
    }
  });

  it.each(
    [false, true].flatMap((security) =>
      (['claim', 'renew', 'retry'] as const).map((site) => ({ security, site })),
    ),
  )(
    '$security security outbox: $site floors the deadline, including fractional intervals',
    async ({ security, site }) => {
      const id = ulid();
      const past = new Date('2000-01-01T00:00:00Z');
      if (security) {
        await prisma.client.securityEventOutbox.create({
          data: {
            id,
            actorType: 'SYSTEM',
            actorId: id,
            action: 'test.rounding',
            resourceType: 'Test',
            errorCode: 'FORBIDDEN',
            correlationId: id,
            producerVersion: 'test',
            occurredAt: past,
            windowStartedAt: past,
            windowEndsAt: new Date(past.getTime() + 1000),
          },
        });
      } else {
        await prisma.client.outboxMessage.create({
          data: {
            id,
            aggregateType: 'Test',
            aggregateId: id,
            eventName: 'test',
            topic: 'test',
            partitionKey: id,
            payload: {},
            headers: {},
            correlationId: id,
          },
        });
      }
      const store = security ? new SecurityEventOutboxStore(prisma) : new PrismaOutboxStore(prisma);
      const claim = await store.claimPending({
        limit: 1000,
        owner: 'rounding-test',
        leaseSeconds: 60,
      });
      expect(claim.rows.map((row) => row.id)).toContain(id);
      if (site === 'renew')
        expect(await store.renew([id], claim.token!, 60.0006, 5000)).toEqual([id]);
      if (site === 'retry')
        expect(
          await store.markFailed(id, claim.token!, 'test', {
            baseSeconds: 60.0006,
            maxSeconds: 60.0006,
          }),
        ).toBe(1);
      const row = security
        ? await prisma.client.securityEventOutbox.findUniqueOrThrow({ where: { id } })
        : await prisma.client.outboxMessage.findUniqueOrThrow({ where: { id } });
      expect((site === 'retry' ? row.nextAttemptAt : row.claimExpiresAt)!.getTime() - AT).toBe(
        60_000,
      );
      // Clock .123 plus 60.0006 floors to .123: never beyond the interval.
      if (site !== 'retry') await store.markPublished([id], claim.token!);
    },
  );

  it.each(['open', 'fresh-unknown', 'fresh-known', 'confirm'] as const)(
    '%s stores exact millisecond fence deadlines',
    async (site) => {
      const id = ulid();
      await prisma.client.$executeRaw`
        INSERT INTO "user" (id, keycloak_id, username, email, first_name, last_name,
                            created_by, updated_by, updated_at)
        VALUES (${id}, ${id}, ${id}, ${`${id}@example.test`}, 'Test', 'Clock',
                ${id}, ${id}, now())`;
      let monotonic = 0;
      const fences = new KeycloakWriteFences(pool, { monotonicNow: () => monotonic });
      const attempt = await new IdentityRepository(prisma).transaction((tx) =>
        fences.open(tx, {
          userId: id,
          keycloakId: id,
          operation: 'replace_attributes',
          timeoutMs: 60_123,
          settleSeconds: 15,
          transactionTimeoutMs: 20_000,
        }),
      );
      if (site.startsWith('fresh')) {
        attempt.assertDispatchable();
        monotonic = 60_124;
        expect(attempt.observeReply()).toBe(true);
        expect(await fences.recoverLate(attempt, site === 'fresh-known')).toBe(true);
      }
      if (site === 'confirm') expect(await fences.confirmLanded([attempt.id])).toBe(true);
      const rows = await prisma.client.$queryRaw<
        Array<{ started: Date; deadline: Date; takeover: Date; retry: Date }>
      >`
      SELECT started_at AS started, deadline_at AS deadline, takeover_at AS takeover,
             next_reassert_at AS retry FROM keycloak_write_attempt WHERE user_id = ${id}`;
      expect(rows).toHaveLength(site.startsWith('fresh') ? 2 : 1);
      for (const row of rows) {
        const resolved =
          site === 'confirm' ||
          (site === 'fresh-known' && row.deadline.getTime() === row.takeover.getTime());
        expect(row.started.getTime()).toBe(AT);
        expect(row.deadline.getTime() - AT).toBe(resolved ? 0 : 60_123);
        expect(row.takeover.getTime() - AT).toBe(resolved ? 0 : 75_123);
        expect(row.retry.getTime()).toBe(row.takeover.getTime());
      }
    },
  );
});
