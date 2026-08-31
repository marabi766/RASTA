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
 * when the key is not there, and what `FOR UPDATE SKIP LOCKED` does when two
 * relays run at once, are properties of PostgreSQL and S3 rather than of this
 * code, so a mock would assert the mock.
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

  it('claims pending rows and maps every column the relay needs', async () => {
    const [id] = await seed(1);

    const claimed = await store.claimPending(100);
    const row = claimed.find((candidate) => candidate.id === id);

    expect(row).toBeDefined();
    expect(row).toMatchObject({
      aggregateType: 'Document',
      eventName: 'DOCUMENT_UPLOADED',
      topic: 'rasta.document.v1',
      organizationId,
      publishedAt: null,
      attempts: 0,
    });
    // The raw query selects snake_case columns; a mapping slip here would
    // publish an event with an undefined topic and no test would say so.
    expect(row?.headers).toEqual({});
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('does not claim a row that was already published', async () => {
    const ids = await seed(1, new Date());
    const claimed = await store.claimPending(100);
    expect(claimed.map((row) => row.id)).not.toContain(ids[0]);
  });

  it('honours the limit', async () => {
    await seed(3);
    expect((await store.claimPending(2)).length).toBeLessThanOrEqual(2);
  });

  it('marks rows published, and does nothing at all for an empty list', async () => {
    const ids = await seed(2);

    await store.markPublished([]);
    expect((await rowsOf(ids)).every((row) => row.publishedAt === null)).toBe(true);

    await store.markPublished(ids);
    expect((await rowsOf(ids)).every((row) => row.publishedAt !== null)).toBe(true);
  });

  it('records a failure as an attempt and a reason', async () => {
    // The relay retries, and "how many times, and why" is the only evidence
    // available when a topic has been rejecting a row for an hour.
    const [id] = await seed(1);

    await store.markFailed(id, 'broker refused the write');
    await store.markFailed(id, 'broker refused the write again');

    const [row] = await rowsOf([id]);
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe('broker refused the write again');
  });

  it('counts what is still pending', async () => {
    const before = await store.pendingCount();
    await seed(2);
    expect(await store.pendingCount()).toBe(before + 2);
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
