import { eligibilityClockSql, eligibilityClockWrite } from '@rasta/testing';
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
const before100 = () => new Date(AT - 100_000);
const clock = (sql: string): string =>
  sql
    .replaceAll('clock_timestamp()', INSTANT)
    .replaceAll('now()', INSTANT)
    .replaceAll('statement_timestamp()', INSTANT);
const onClock = (
  client: ExtendedPrismaClient,
  raw: Pick<ExtendedPrismaClient, '$executeRaw' | '$queryRawUnsafe' | '$executeRawUnsafe'>,
): ExtendedPrismaClient => {
  const execute = raw.$executeRaw.bind(client);
  const queryUnsafe = raw.$queryRawUnsafe.bind(client);
  const executeUnsafe = raw.$executeRawUnsafe.bind(client);
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

describe('TIMESTAMP(3) deadline bounds (FU-162/FU-170, real PostgreSQL)', () => {
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
      'membership',
      'registration_intake',
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
    // The private outbox changes type below; do not reuse prepared row shapes.
    url.searchParams.set('statement_cache_size', '0');
    prisma = new PrismaService(url.toString());
    pool = new PrismaService(url.toString());
    await prisma.onModuleInit();
    await pool.onModuleInit();
  });
  beforeEach(() => {
    for (const db of [prisma, pool]) {
      // Capture originals: transaction methods must not inherit spies bound to the pool.
      const raw = {
        $executeRaw: db.client.$executeRaw,
        $queryRawUnsafe: db.client.$queryRawUnsafe,
        $executeRawUnsafe: db.client.$executeRawUnsafe,
      };
      const transaction = db.transaction.bind(db);
      jest
        .spyOn(db, 'transaction')
        .mockImplementation((work, options) =>
          transaction((tx) => work(onClock(tx, raw)), options),
        );
      const frozen = onClock(db.client, raw);
      jest.spyOn(db.client, '$executeRaw').mockImplementation(frozen.$executeRaw);
      jest.spyOn(db.client, '$queryRawUnsafe').mockImplementation(frozen.$queryRawUnsafe);
      jest.spyOn(db.client, '$executeRawUnsafe').mockImplementation(frozen.$executeRawUnsafe);
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // A failed assertion rolls back its transaction; remove the seed too so
    // later cases (including mutants) cannot claim a previous case's fixture.
    await prisma.client.outboxMessage.deleteMany();
    await prisma.client.securityEventOutbox.deleteMany();
  });
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
    [
      { security: false, aware: false },
      { security: false, aware: true },
      { security: true, aware: false },
    ].flatMap((kind) =>
      (['claim', 'renew', 'retry'] as const).flatMap((site) =>
        [false, true].map((switchZone) => ({ ...kind, site, switchZone })),
      ),
    ),
  )(
    'security=$security aware=$aware switchZone=$switchZone: $site stays UTC and floors fractional intervals',
    async ({ security, aware, site, switchZone }) => {
      // Exercise both deployed outbox column types, in our private schema.
      if (!security) {
        const type = aware ? 'timestamptz' : 'timestamp';
        await owner.client.$executeRawUnsafe(
          `ALTER TABLE "${schema}".outbox_message
           ALTER COLUMN claim_expires_at TYPE ${type}(3) USING claim_expires_at AT TIME ZONE 'UTC',
           ALTER COLUMN next_attempt_at TYPE ${type}(3) USING next_attempt_at AT TIME ZONE 'UTC',
           ALTER COLUMN published_at TYPE ${type}(3) USING published_at AT TIME ZONE 'UTC',
           ALTER COLUMN created_at TYPE ${type}(3) USING created_at AT TIME ZONE 'UTC'`,
        );
      }
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
      await prisma.transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TimeZone='Asia/Tehran'");
        expect(await tx.$queryRawUnsafe('SHOW TimeZone')).toEqual([{ TimeZone: 'Asia/Tehran' }]);
        // Every production statement, including nested renew transactions, uses
        // this connection; SET LOCAL cannot leak into another test or pool.
        const local = new Proxy(prisma, {
          get(target, key, receiver) {
            if (key === 'client') return tx;
            if (key === 'transaction')
              return (work: (client: ExtendedPrismaClient) => unknown) => work(tx);
            return Reflect.get(target, key, receiver);
          },
        });
        const store = security ? new SecurityEventOutboxStore(local) : new PrismaOutboxStore(local);
        const claim = await store.claimPending({
          limit: 1000,
          owner: 'rounding-test',
          leaseSeconds: 60.0006,
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
          ? await tx.securityEventOutbox.findUniqueOrThrow({ where: { id } })
          : await tx.outboxMessage.findUniqueOrThrow({ where: { id } });
        expect((site === 'retry' ? row.nextAttemptAt : row.claimExpiresAt)!.getTime() - AT).toBe(
          60_000,
        );
        if (switchZone) await tx.$executeRawUnsafe("SET LOCAL TimeZone='UTC'");
        expect(await store.activeLeaseCount()).toBe(site === 'retry' ? 0 : 1);
        const contender = await store.claimPending({
          limit: 1000,
          owner: 'contender',
          leaseSeconds: 60,
        });
        expect(contender.rows.map((row) => row.id)).not.toContain(id);
        // Cover the paired-deadline candidate stream as well as lease/retry.
        const table = security ? 'security_event_outbox' : 'outbox_message';
        await tx.$executeRawUnsafe(
          eligibilityClockSql`UPDATE ${table} SET attempts = GREATEST(attempts, 1), last_error = 'test', next_attempt_at = claim_expires_at WHERE id = $1 AND claim_expires_at IS NOT NULL`,
          id,
        );
        expect(
          (await store.claimPending({ limit: 1000, owner: 'paired', leaseSeconds: 60 })).rows.map(
            (row) => row.id,
          ),
        ).not.toContain(id);
        await tx.$executeRawUnsafe(
          eligibilityClockSql`UPDATE ${table} SET claim_expires_at = claim_expires_at - interval '60 seconds',
            next_attempt_at = next_attempt_at - interval '60 seconds' WHERE id = $1`,
          id,
        );
        const due = await store.claimPending({ limit: 1000, owner: 'due', leaseSeconds: 60 });
        expect(due.rows.map((row) => row.id)).toContain(id);
        expect(await store.markPublished([id], claim.token!)).toBe(0);
        expect(await store.markPublished([id], due.token!)).toBe(1);
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE id = $1`, id);
        // Clock .123 plus 60.0006 floors to .123: never beyond the interval.
      });
    },
  );

  // FU-188: the stamp, the age gauge and the purge, in both zones around UTC and both
  // column types: a bare clock would be off by the offset here.
  it.each(
    ['Asia/Tehran', 'America/Los_Angeles'].flatMap((zone) =>
      [false, true].map((aware) => ({ zone, aware })),
    ),
  )('outbox stamp, gauge and purge in $zone, aware=$aware', async ({ zone, aware }) => {
    const type = aware ? 'timestamptz' : 'timestamp';
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".outbox_message
       ALTER COLUMN claim_expires_at TYPE ${type}(3) USING claim_expires_at AT TIME ZONE 'UTC',
       ALTER COLUMN next_attempt_at TYPE ${type}(3) USING next_attempt_at AT TIME ZONE 'UTC',
       ALTER COLUMN published_at TYPE ${type}(3) USING published_at AT TIME ZONE 'UTC',
       ALTER COLUMN created_at TYPE ${type}(3) USING created_at AT TIME ZONE 'UTC'`,
    );
    const row = (id: string, createdAt: Date, publishedAt?: Date) => ({
      id,
      aggregateType: 'Test',
      aggregateId: id,
      eventName: 'test',
      topic: 'test',
      partitionKey: id,
      payload: {},
      headers: {},
      correlationId: id,
      createdAt,
      publishedAt: publishedAt ?? null,
    });
    const [pending, stale, kept] = [ulid(), ulid(), ulid()];
    const before = (seconds: number) => new Date(AT - seconds * 1000);
    await prisma.client.outboxMessage.createMany({
      data: [
        row(pending, before(100)),
        row(stale, before(3601), before(3601)),
        row(kept, before(3599), before(3599)),
      ],
    });
    await prisma.transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TimeZone='${zone}'`);
      const local = new Proxy(prisma, {
        get(target, key, receiver) {
          if (key === 'client') return tx;
          if (key === 'transaction')
            return (work: (client: ExtendedPrismaClient) => unknown) => work(tx);
          return Reflect.get(target, key, receiver);
        },
      });
      const store = new PrismaOutboxStore(local);
      expect(await store.oldestPendingAgeSeconds()).toBeCloseTo(100, 0);
      const claim = await store.claimPending({ limit: 1000, owner: 'stamp', leaseSeconds: 60 });
      expect(await store.markPublished([pending], claim.token!)).toBe(1);
      const published = await tx.outboxMessage.findUniqueOrThrow({ where: { id: pending } });
      expect(published.publishedAt!.getTime()).toBe(AT);
      const purged = await store.purgePublished({
        retentionSeconds: 3600,
        limit: 1000,
        statementTimeoutMs: 5000,
        maxWaitMs: 1000,
      });
      expect(purged).toEqual({ deleted: 1, busy: false });
      const left = await tx.outboxMessage.findMany({ select: { id: true } });
      expect(left.map(({ id }) => id).sort()).toEqual([pending, kept].sort());
    });
  });

  it.each(['Asia/Tehran', 'America/Los_Angeles'])(
    'security-event stamp and gauge in %s',
    async (zone) => {
      const id = ulid();
      const past = before100();
      await prisma.client.securityEventOutbox.create({
        data: {
          id,
          actorType: 'SYSTEM',
          actorId: id,
          action: 'test.stamp',
          resourceType: 'Test',
          errorCode: 'FORBIDDEN',
          correlationId: id,
          producerVersion: 'test',
          occurredAt: past,
          createdAt: past,
          windowStartedAt: past,
          windowEndsAt: new Date(past.getTime() + 1000),
        },
      });
      await prisma.transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TimeZone='${zone}'`);
        const local = new Proxy(prisma, {
          get(target, key, receiver) {
            if (key === 'client') return tx;
            if (key === 'transaction')
              return (work: (client: ExtendedPrismaClient) => unknown) => work(tx);
            return Reflect.get(target, key, receiver);
          },
        });
        const store = new SecurityEventOutboxStore(local);
        expect(await store.oldestPendingAgeSeconds()).toBeCloseTo(100, 0);
        const claim = await store.claimPending({ limit: 1000, owner: 'stamp', leaseSeconds: 60 });
        expect(await store.markPublished([id], claim.token!)).toBe(1);
        const row = await tx.securityEventOutbox.findUniqueOrThrow({ where: { id } });
        expect(row.publishedAt!.getTime()).toBe(AT);
      });
    },
  );

  it.each(['intake', 'lapse', 'reassert'] as const)(
    '%s floors a total backoff with a sub-millisecond interval',
    async (site) => {
      const id = ulid();
      const repository = new IdentityRepository(prisma);
      if (site === 'intake') {
        await prisma.client.registrationIntake.create({
          data: { id, submission: {}, actorType: 'ANONYMOUS', correlationId: id },
        });
        await repository.deferRegistrationIntake(id, 0.0006, 1);
      } else if (site === 'lapse') {
        await prisma.client.$executeRaw`
          INSERT INTO membership (id, user_id, organization_id, roles, created_by, updated_by, updated_at)
          VALUES (${id}, ${id}, ${id}, ARRAY['OPERATOR'], ${id}, ${id}, now())`;
        await repository.deferLapse(id, 0.0006, 1);
      } else {
        await eligibilityClockWrite(prisma.client)`
          INSERT INTO keycloak_write_attempt
            (attempt_id, user_id, keycloak_id, operation, started_at, deadline_at, takeover_at, next_reassert_at)
          VALUES (${id}, ${id}, ${id}, 'replace_attributes',
            TIMESTAMP '2000-01-01', TIMESTAMP '2000-01-01', TIMESTAMP '2000-01-01', TIMESTAMP '2000-01-01')`;
        await new KeycloakWriteFences(pool).deferReassert(id, 0.0006, 1);
      }
      const table =
        site === 'intake'
          ? 'registration_intake'
          : site === 'lapse'
            ? 'membership'
            : 'keycloak_write_attempt';
      const column =
        site === 'intake'
          ? 'next_attempt_at'
          : site === 'lapse'
            ? 'lapse_retry_at'
            : 'next_reassert_at';
      const key = site === 'reassert' ? 'attempt_id' : 'id';
      const [row] = await prisma.client.$queryRawUnsafe<Array<{ deadline: Date }>>(
        `SELECT ${column} AS deadline FROM ${table} WHERE ${key} = $1`,
        id,
      );
      expect(row!.deadline.getTime()).toBe(AT);
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
          timeoutMs: 60_123.6,
          settleSeconds: 15.0006,
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
        expect(row.takeover.getTime() - AT).toBe(resolved ? 0 : 75_124);
        expect(row.retry.getTime()).toBe(row.takeover.getTime());
      }
    },
  );
});
