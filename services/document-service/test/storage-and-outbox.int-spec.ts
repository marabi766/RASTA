import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { InMemoryEventPublisher } from '../src/outbox/kafka.publisher';
import {
  FIXTURES,
  getFromSignedUrl,
  newPrisma,
  newStorage,
  putToSignedUrl,
  testEnv,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { S3ObjectStorage } from '../src/storage/s3.storage';

/**
 * The two boundaries, exercised directly against the systems they wrap.
 *
 * These paths are reached only incidentally by the lifecycle suites — a
 * missing object, a ranged read, a relay claiming rows — and each is a place
 * where "it worked in the happy path" says nothing useful. What a bucket does
 * when the key is not there, and what the claim query returns against a real
 * table, are properties of PostgreSQL and S3 rather than of this code, so a
 * mock would assert the mock.
 *
 * Note what `FOR UPDATE SKIP LOCKED` does *not* do here. Its lock lives only
 * as long as the transaction holding it, and the claim is a standalone
 * SELECT — so two relays running at once can claim the same rows, and do
 * (D-026). Nothing in this file should be read as proving otherwise.
 */
describe('object storage, against a real bucket', () => {
  const env = testEnv();
  let storage: S3ObjectStorage;
  const written: string[] = [];

  beforeAll(() => {
    storage = newStorage(env);
  });

  afterAll(async () => {
    await Promise.all(written.map((key) => storage.remove(key).catch(() => undefined)));
  });

  /** A key shaped exactly like a real one, so nothing is exercised off-format. */
  const key = () => {
    const value = `documents/ORG-STORETEST/CONTRACT/${ulid()}`;
    written.push(value);
    return value;
  };

  async function put(objectKey: string, bytes: Buffer, contentType = 'application/pdf') {
    const url = await storage.createUploadUrl({ objectKey, contentType, expiresInSeconds: 300 });
    expect(await putToSignedUrl(url, bytes, contentType)).toBe(200);
  }

  describe('reading an object that is not there', () => {
    it('answers null from head rather than throwing', async () => {
      // The difference between "no object was uploaded for this intent", which
      // is a 422 a client can act on, and a 500.
      expect(await storage.head(`documents/ORG-STORETEST/CONTRACT/${ulid()}`)).toBeNull();
    });

    it('lets a delete of a missing key succeed', async () => {
      // S3 deletes are idempotent, and this service depends on it: the
      // tombstone commits first, so a retried removal must not fail.
      await expect(
        storage.remove(`documents/ORG-STORETEST/CONTRACT/${ulid()}`),
      ).resolves.toBeUndefined();
    });
  });

  describe('what head reports about an object that is there', () => {
    it('returns the size storage actually holds, not what anyone declared', async () => {
      const objectKey = key();
      const bytes = FIXTURES.pdf();
      await put(objectKey, bytes);

      const metadata = await storage.head(objectKey);
      expect(metadata?.sizeBytes).toBe(bytes.length);
      expect(metadata?.etag).toBeTruthy();
      expect(metadata?.lastModified).toBeInstanceOf(Date);
    });
  });

  describe('reading only a prefix', () => {
    it('returns just the bytes asked for, not the object', async () => {
      // The service reads a header to identify content. If this ever returned
      // the whole object, a 25MB upload would pass through the service's
      // memory — the exact thing ADR-014 avoids.
      const objectKey = key();
      const bytes = FIXTURES.pdf();
      await put(objectKey, bytes);

      const prefix = await storage.readPrefix(objectKey, 8);
      expect(prefix.length).toBe(8);
      expect(Buffer.from(prefix).toString('latin1')).toBe('%PDF-1.4');
    });

    it('returns what exists when the object is shorter than the range', async () => {
      const objectKey = key();
      const bytes = FIXTURES.png();
      await put(objectKey, bytes, 'image/png');

      const prefix = await storage.readPrefix(objectKey, 4096);
      expect(prefix.length).toBe(bytes.length);
    });
  });

  describe('the signed URLs themselves', () => {
    it('signs an upload URL to one content type, so it cannot be reused for another', async () => {
      // Not a substitute for inspecting the bytes — a client can send matching
      // headers and different content — but it does stop one URL from being
      // reused for something else entirely.
      const objectKey = key();
      const url = await storage.createUploadUrl({
        objectKey,
        contentType: 'application/pdf',
        expiresInSeconds: 300,
      });

      const wrongType = await putToSignedUrl(url, FIXTURES.pdf(), 'text/html');
      expect(wrongType).toBeGreaterThanOrEqual(400);
    });

    it('serves a download as an attachment with the type it was given', async () => {
      // ADR-014: stored content is never rendered. `attachment` plus an
      // explicit type is what enforces that at the storage boundary.
      const objectKey = key();
      await put(objectKey, FIXTURES.pdf());

      const url = await storage.createDownloadUrl({
        objectKey,
        expiresInSeconds: 300,
        downloadFilename: 'the contract.pdf',
        contentType: 'application/pdf',
      });
      const fetched = await getFromSignedUrl(url);

      expect(fetched.status).toBe(200);
      expect(fetched.contentDisposition).toMatch(/^attachment/);
      expect(fetched.contentType).toBe('application/pdf');
    });

    it('refuses a URL whose expiry has passed', async () => {
      // The expiry is the only thing standing between a link and a permanent
      // public read, so it is worth proving that storage enforces it rather
      // than that this service passes the number along.
      const objectKey = key();
      await put(objectKey, FIXTURES.pdf());

      const url = await storage.createDownloadUrl({
        objectKey,
        expiresInSeconds: 1,
        downloadFilename: 'expired.pdf',
        contentType: 'application/pdf',
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect((await getFromSignedUrl(url)).status).toBe(403);
    });

    it('never puts the secret key in the URL', async () => {
      // A signed URL carries the access key id by design; the secret is what
      // signs it and must never appear.
      const url = await storage.createUploadUrl({
        objectKey: key(),
        contentType: 'application/pdf',
        expiresInSeconds: 300,
      });

      expect(url).not.toContain(env.S3_SECRET_KEY);
      expect(url).toContain('X-Amz-Signature');
    });
  });

  describe('readiness', () => {
    it('reports the configured bucket as reachable', async () => {
      expect(await storage.isHealthy()).toBe(true);
    });

    it('reports a bucket that does not exist as unreachable, without throwing', async () => {
      // A readiness probe that throws reads as a 500 rather than as "not
      // ready", and an orchestrator treats those differently.
      const missing = newStorage({ ...env, S3_BUCKET_DOCUMENTS: `no-such-bucket-${ulid()}` });
      expect(await missing.isHealthy()).toBe(false);
    });
  });
});

describe('the outbox store, against a real database', () => {
  let prisma: PrismaService;
  let store: PrismaOutboxStore;
  const organizationId = `ORG-OUTBOXTEST-${ulid().slice(-10)}`;

  /**
   * The claim window, without the fencing protocol.
   *
   * These assertions are about which rows the query returns; the token
   * mechanics have their own suite against an isolated schema
   * (`outbox-durable-claim.int-spec.ts`). A zero lease is used so a claim here
   * never parks rows for another suite.
   */
  const claimRows = async (limit: number) =>
    (await store.claimPending({ limit, owner: 'int-spec', leaseSeconds: 0 })).rows;

  const claimWithToken = (limit: number) =>
    store.claimPending({ limit, owner: 'int-spec', leaseSeconds: 0 });

  beforeAll(() => {
    prisma = newPrisma();
    store = new PrismaOutboxStore(prisma);
  });

  afterAll(async () => {
    await runUnscoped('the suite removes the rows it created', () =>
      prisma.client.outboxMessage.deleteMany({ where: { organizationId } }),
    );
    await prisma.onModuleDestroy();
  });

  async function seed(count: number, publishedAt: Date | null = null): Promise<string[]> {
    const ids: string[] = [];
    await runUnscoped('the suite seeds outbox rows', async () => {
      for (let index = 0; index < count; index += 1) {
        const id = `OBX_${ulid()}`;
        ids.push(id);
        await prisma.client.outboxMessage.create({
          data: {
            id,
            aggregateType: 'Document',
            aggregateId: `DOC_${ulid()}`,
            eventName: 'DOCUMENT_UPLOADED',
            eventVersion: 1,
            topic: 'rasta.document.v1',
            partitionKey: `DOC_${index}`,
            payload: { probe: true },
            headers: {},
            organizationId,
            correlationId: `COR-${ulid()}`,
            publishedAt,
          },
        });
      }
    });
    return ids;
  }

  const rowsOf = (ids: string[]) =>
    runUnscoped('the suite reads the rows back', () =>
      prisma.client.outboxMessage.findMany({ where: { id: { in: ids } } }),
    );

  /**
   * How many of exactly these rows are still outstanding.
   *
   * The same predicate `pendingCount()` applies, narrowed to rows one test
   * created — which is the only part any test can assert exactly. Scoping by
   * `organizationId` alone is not enough and repeating the original mistake
   * one level down: every test in this file seeds under the same organization,
   * so "my organization's pending rows" already counts rows the earlier tests
   * left behind. The ids are unique per insert; the organization is asserted
   * alongside them so the rows are provably this suite's.
   *
   * The production gauge stays unscoped. This narrowing exists only in the
   * test, so that "how many of mine are pending" has a deterministic answer
   * against a database every suite shares.
   */
  const pendingAmong = (ids: string[]) =>
    runUnscoped('the suite counts its own pending rows', () =>
      prisma.client.outboxMessage.count({
        where: { id: { in: ids }, organizationId, publishedAt: null },
      }),
    );

  /**
   * `claimPending(limit)` returns a *window*, and this suite does not own the
   * ordering that decides it.
   *
   * The assertion that used to live here seeded one row, claimed 100, and
   * required its own row to be among them. That is not a property of the
   * implementation. The query takes the **oldest** hundred unpublished rows
   * across the whole table, so a freshly inserted row — the newest pending row
   * there is — belongs in the window only while the shared database holds
   * fewer than a hundred older ones. With more, its absence is the query
   * working, not failing. D-024 was the same mistake on `COUNT`; this was it
   * on `LIMIT` and `ORDER BY`.
   *
   * What is asserted instead are the guarantees the query actually makes, on
   * the rows it actually returned. Column mapping moved to
   * `src/outbox/outbox.store.spec.ts`, where a controlled raw row proves every
   * snake_case field lands in the right place without needing any particular
   * row to be in the window.
   */
  it('returns a bounded, unpublished, oldest-first window', async () => {
    await seed(3);

    const claimed = await claimRows(10);

    // Bounded by the limit. Not "exactly 10" — the table may hold fewer.
    expect(claimed.length).toBeLessThanOrEqual(10);
    expect(claimed.length).toBeGreaterThan(0);

    // `WHERE published_at IS NULL`, on every row that came back.
    expect(claimed.every((row) => row.publishedAt === null)).toBe(true);

    // `ORDER BY created_at`, on every row that came back.
    const times = claimed.map((row) => row.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // The mapper ran on real rows: every column the relay needs is present and
    // of the right type. This is the shape check; the field-by-field mapping is
    // pinned against a controlled raw row in the unit test.
    for (const row of claimed) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.aggregateType).toBe('string');
      expect(typeof row.aggregateId).toBe('string');
      expect(typeof row.eventName).toBe('string');
      expect(typeof row.eventVersion).toBe('number');
      expect(typeof row.topic).toBe('string');
      expect(typeof row.partitionKey).toBe('string');
      expect(typeof row.correlationId).toBe('string');
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.headers).toBeDefined();
      expect(typeof row.attempts).toBe('number');
    }
  });

  it('asks for no more rows than it was given room for', async () => {
    await seed(3);

    // A limit smaller than the number of pending rows this suite alone just
    // created, so the bound is doing work rather than being vacuously true.
    expect((await claimRows(1)).length).toBe(1);
    expect((await claimRows(2)).length).toBe(2);
  });

  it('does not claim a row that was already published', async () => {
    const ids = await seed(1, new Date());
    const claimed = await claimRows(100);
    expect(claimed.map((row) => row.id)).not.toContain(ids[0]);
  });

  it('honours the limit', async () => {
    await seed(3);
    expect((await claimRows(2)).length).toBeLessThanOrEqual(2);
  });

  it('marks rows published, and does nothing at all for an empty list', async () => {
    const ids = await seed(2);

    const claimed = await claimWithToken(100);
    const token = claimed.token!;

    expect(await store.markPublished([], token)).toBe(0);
    expect((await rowsOf(ids)).every((row) => row.publishedAt === null)).toBe(true);

    expect(await store.markPublished(ids, token)).toBe(ids.length);
    expect((await rowsOf(ids)).every((row) => row.publishedAt !== null)).toBe(true);
  });

  it('records a failure as an attempt and a reason', async () => {
    // The relay retries, and "how many times, and why" is the only evidence
    // available when a topic has been rejecting a row for an hour.
    const [id] = await seed(1);

    // Each failure releases the claim, so the row is re-claimed for the second
    // one — which is exactly what the relay does on the next tick.
    const backoff = { baseSeconds: 0, maxSeconds: 0 };
    const first = await claimWithToken(100);
    expect(await store.markFailed(id, first.token!, 'broker refused the write', backoff)).toBe(1);

    const second = await claimWithToken(100);
    expect(
      await store.markFailed(id, second.token!, 'broker refused the write again', backoff),
    ).toBe(1);

    const [row] = await rowsOf([id]);
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe('broker refused the write again');
  });

  /**
   * `pendingCount()` is a platform-wide gauge, and this suite does not own the
   * table.
   *
   * The assertion that used to live here took two global counts around two
   * inserts and required the difference to be exactly two. That is not a
   * property of the implementation. It is a property of nobody else writing to
   * `outbox_message` in between, which nothing establishes: the count is
   * deliberately unscoped, every suite sharing this database contributes to
   * it, and a relay publishing, a suite cleaning up, or another insert all
   * move it. `repro` in the commit message records all three reproduced
   * deterministically — a concurrent create, publish and delete each break the
   * old assertion while `pendingCount()` behaves perfectly correctly.
   *
   * What this suite can own is its own rows, so that is what is asserted
   * exactly. The global gauge gets a lower bound, which is genuinely all that
   * holds; the predicate it applies is pinned precisely — and deterministically
   * — in `src/outbox/outbox.store.spec.ts`, so an implementation that counted
   * published rows or filtered by tenant still fails, just not here.
   */
  it('counts this suite’s unpublished rows, and never its published ones', async () => {
    const unpublished = await seed(3);
    const published = await seed(2, new Date());

    // Exact, because it names the rows: these three ids, under this suite's
    // organization, still unpublished.
    expect(await pendingAmong(unpublished)).toBe(3);
    expect(await pendingAmong(published)).toBe(0);

    // The published rows exist and are excluded by the predicate rather than
    // absent from the table — the difference between "not counted" and "not
    // there", which is what makes this an assertion about `publishedAt`.
    expect(await rowsOf(published)).toHaveLength(2);
    expect((await rowsOf(published)).every((row) => row.publishedAt !== null)).toBe(true);

    // All this suite's unpublished rows are outstanding somewhere in the
    // global backlog. A count that dropped them would break this; a count that
    // included the published two would not — that case is the unit test's.
    expect(await store.pendingCount()).toBeGreaterThanOrEqual(3);
    expect(await store.pendingCount()).toBeGreaterThanOrEqual(await pendingAmong(unpublished));

    // Publishing moves a row out of the pending set, exactly and by name.
    const owned = await claimWithToken(500);
    await store.markPublished(unpublished.slice(0, 2), owned.token!);
    expect(await pendingAmong(unpublished)).toBe(1);
  });

  it('is a platform gauge, not a tenant one', async () => {
    // The reason the old assertion was unsound, stated as the property it
    // actually is. `rasta_outbox_pending_total` reports the whole relay
    // backlog: the outbox is platform plumbing and a per-tenant gauge would
    // hide the outage it exists to reveal (ADR-006). This also fixes that
    // meaning in place — an `organizationId` filter added to the production
    // metric would fail here as well as in the unit test.
    const foreign = `ORG-OUTBOXTEST-OTHER-${ulid().slice(-10)}`;
    const foreignId = `OBX_${ulid()}`;

    try {
      await runUnscoped('another organization writes to the shared outbox', () =>
        prisma.client.outboxMessage.create({
          data: {
            id: foreignId,
            aggregateType: 'Document',
            aggregateId: `DOC_${ulid()}`,
            eventName: 'DOCUMENT_UPLOADED',
            eventVersion: 1,
            topic: 'rasta.document.v1',
            partitionKey: 'DOC_FOREIGN',
            payload: { probe: true },
            headers: {},
            organizationId: foreign,
            correlationId: `COR-${ulid()}`,
            publishedAt: null,
          },
        }),
      );

      // The store's own predicate, applied to this one foreign row: it
      // matches. Nothing about the row's owner excludes it.
      //
      // Deliberately not `pendingCount() === before + 1`. That is the exact
      // global delta this whole change exists to remove — it would be just as
      // unsound here as it was in the test it replaces, and it would fail the
      // moment anything else wrote to the table. That the store issues exactly
      // this predicate, with no `organizationId` alongside it, is asserted
      // where it can be proven exactly: `src/outbox/outbox.store.spec.ts`.
      const matchesThePredicate = await runUnscoped(
        'the suite applies the gauge’s predicate to the foreign row',
        () =>
          prisma.client.outboxMessage.count({
            where: { id: foreignId, publishedAt: null },
          }),
      );

      expect(matchesThePredicate).toBe(1);
      expect(await store.pendingCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await runUnscoped('remove only the row this test created', () =>
        prisma.client.outboxMessage.deleteMany({ where: { organizationId: foreign } }),
      );
    }
  });

  it('reports the age of the oldest pending row', async () => {
    await seed(1);
    expect(await store.oldestPendingAgeSeconds()).toBeGreaterThanOrEqual(0);
  });

  it('purges published rows older than the retention window, and only those', async () => {
    const old = await seed(1, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const recent = await seed(1, new Date());
    const unpublished = await seed(1);

    await store.purgePublished(7);

    expect(await rowsOf(old)).toHaveLength(0);
    expect(await rowsOf(recent)).toHaveLength(1);
    // An unpublished row is an event nobody has received yet. Deleting it
    // would lose it silently, which is worse than keeping it forever.
    expect(await rowsOf(unpublished)).toHaveLength(1);
  });

  /**
   * The window, proven against a backlog bigger than it.
   *
   * This is the condition the old assertion could not survive, kept as a test
   * rather than as a note. The fixture inserts more than a thousand pending
   * rows dated in the year 2000 — far enough back that they sort ahead of
   * anything a normal run produces, and numerous enough that the window is
   * always full.
   *
   * What the assertions below claim about them is carefully limited. The
   * fixture is not assumed to *own* the oldest hundred rows on the platform:
   * another suite may hold rows just as old, and an assertion that failed in
   * that case would be this defect all over again, one level up. What holds
   * regardless is that the fixture's rows *inside* the window are its own
   * oldest ones, contiguously — a row can only be there if every row older
   * than it is there too. Nothing outside the fixture is read, deleted or
   * depended upon.
   *
   * A backlog this size is also the real operational case: a relay that has
   * been down for an hour comes back to exactly this, and "the oldest hundred
   * first" is the property that lets it drain in order instead of starving the
   * events that have waited longest.
   */
  describe('with more than a thousand older pending rows', () => {
    const backlogOrg = `ORG-OUTBOXTEST-BACKLOG-${ulid().slice(-10)}`;
    const ANCIENT = new Date('2000-01-01T00:00:00.000Z');
    const BACKLOG = 1200;

    beforeAll(async () => {
      await runUnscoped('the fixture seeds an older backlog', () =>
        prisma.client.outboxMessage.createMany({
          data: Array.from({ length: BACKLOG }, (_, index) => ({
            id: `OBX_${ulid()}`,
            aggregateType: 'Document',
            aggregateId: `DOC_${ulid()}`,
            eventName: 'DOCUMENT_UPLOADED',
            eventVersion: 1,
            topic: 'rasta.document.v1',
            partitionKey: `BACKLOG_${index}`,
            payload: { backlog: true },
            headers: {},
            organizationId: backlogOrg,
            correlationId: `COR-${ulid()}`,
            // One second apart, so the ordering is total and no tie-break is
            // needed to know which row comes first.
            createdAt: new Date(ANCIENT.getTime() + index * 1000),
            publishedAt: null,
          })),
        }),
      );
    });

    afterAll(async () => {
      await runUnscoped('the fixture removes only its own rows', () =>
        prisma.client.outboxMessage.deleteMany({ where: { organizationId: backlogOrg } }),
      );
    });

    it('fills the window from the oldest rows, and stops at the limit', async () => {
      const claimed = await claimRows(100);

      // Exactly the limit: this fixture alone supplies twelve times as many
      // candidates as the window holds.
      expect(claimed).toHaveLength(100);
      expect(claimed.every((row) => row.publishedAt === null)).toBe(true);

      const times = claimed.map((row) => row.createdAt.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);

      // If any of the fixture's rows are in the window, they are its *oldest*
      // ones with no gaps — row n can only be there if every row older than it
      // is too.
      //
      // Conditional on purpose. Requiring even one fixture row to appear would
      // be the same defect this change exists to remove: the window is global
      // and another suite may hold a hundred rows older than every one of
      // ours, in which case none of the fixture's belong in it and the query
      // is behaving perfectly. Verified deterministically — with 1,200 foreign
      // rows dated 1990 ahead of the fixture's year 2000, `mine` is empty and
      // this still holds, because an empty list trivially equals its own
      // prefix.
      const mine = claimed
        .filter((row) => row.organizationId === backlogOrg)
        .map((row) => row.createdAt.getTime());

      expect(mine).toEqual(mine.map((_, index) => ANCIENT.getTime() + index * 1000));
    });

    it('honours a smaller limit against the same backlog', async () => {
      // Exact, because more than a thousand pending rows are available: a
      // short limit can always be filled.
      expect(await claimRows(1)).toHaveLength(1);
      expect(await claimRows(7)).toHaveLength(7);

      // And a smaller window is a prefix of a larger one — the ordering is
      // total, so asking for fewer rows returns the same oldest rows, not a
      // different selection.
      const seven = (await claimRows(7)).map((row) => row.createdAt.getTime());
      expect([...seven].sort((a, b) => a - b)).toEqual(seven);
      expect(seven[0]).toBeLessThanOrEqual(seven[6] as number);
    });

    it('correctly leaves a newly written row outside the window', async () => {
      // The old assertion, restated as the property it actually is. A row
      // written now is the newest pending row in the table; with a thousand
      // older ones ahead of it, its absence from the first hundred is the
      // query behaving exactly as specified.
      const [fresh] = await seed(1);

      const claimed = await claimRows(100);

      expect(claimed.map((row) => row.id)).not.toContain(fresh);
      expect(claimed).toHaveLength(100);

      // And it is genuinely pending — outside the window, not published and
      // not missing. The difference is the whole point.
      expect(await pendingAmong([fresh])).toBe(1);
    });
  });
});

describe('the in-memory publisher the tests run on', () => {
  it('records what it was asked to publish rather than sending it', async () => {
    // It stands in for Kafka in the API suites, so if it silently dropped
    // messages those suites would prove less than they appear to.
    const publisher = new InMemoryEventPublisher();
    const row = {
      id: 'OBX_1',
      aggregateType: 'Document',
      aggregateId: 'DOC_1',
      eventName: 'DOCUMENT_UPLOADED',
      eventVersion: 1,
      topic: 'rasta.document.v1',
      partitionKey: 'DOC_1',
      payload: { documentId: 'DOC_1' },
      headers: {},
      organizationId: 'ORG-1',
      correlationId: 'COR-1',
      createdAt: new Date(),
      publishedAt: null,
      attempts: 0,
      lastError: null,
    };

    await publisher.publish([row]);

    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]?.eventName).toBe('DOCUMENT_UPLOADED');
  });
});
