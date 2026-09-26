import { runUnscoped } from '@rasta/nest-common';
import { EventPublisher } from '../src/events/publisher';
import { DOCUMENT_EVENTS } from '../src/events/events';
import { DocumentRepository } from '../src/document/document.repository';
import { DocumentService } from '../src/document/document.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { ObjectStorage } from '../src/storage/storage.port';
import { asActor, cleanup, newPrisma, outboxFor, tenants, testEnv } from './helpers';

/**
 * The upload intent is audited (AGENTS.md S-06, global audit L7-14), against a
 * real PostgreSQL.
 *
 * Storage is a stand-in here, unlike the lifecycle suite: issuing an intent
 * only asks storage to *sign* a URL, which involves no bucket, and what this
 * suite proves — that the intent row and `UPLOAD_INTENT_ISSUED` commit
 * together or not at all — lives entirely in the database.
 */
describe('upload intent audit (L7-14)', () => {
  const org = tenants();
  const SIGNED_URL = 'https://storage.invalid/rasta-documents/signed?X-Amz-Signature=itest';
  let prisma: PrismaService;
  let events: EventPublisher;
  let documents: DocumentService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.$queryRawUnsafe('SELECT 1');
    const env = testEnv();
    events = new EventPublisher(env);
    const storage = {
      createUploadUrl: jest.fn(async () => SIGNED_URL),
    } as unknown as ObjectStorage;
    documents = new DocumentService(prisma, new DocumentRepository(prisma), events, env, storage);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const request = (organizationId: string, userId: string) =>
    asActor({ organizationId, userId }, () =>
      documents.requestUploadUrl({
        documentClass: 'CONTRACT',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        filename: 'قرارداد.pdf',
      }),
    );

  const intentRow = (intentId: string) =>
    runUnscoped('read back the fixture', () =>
      prisma.client.uploadIntent.findUnique({ where: { id: intentId } }),
    );

  const intentEvents = async (organizationId: string) =>
    (await outboxFor(prisma, organizationId)).filter(
      (row) => row.eventName === DOCUMENT_EVENTS.UPLOAD_INTENT_ISSUED,
    );

  it('commits exactly one event for the intent, with the requester as actor, under their tenant', async () => {
    const before = (await intentEvents(org.a)).length;

    const issued = await request(org.a, 'USR-DOC-A');

    const rows = (await intentEvents(org.a)).filter(
      (row) => row.aggregateId === issued.uploadIntentId,
    );
    expect(rows).toHaveLength(1);
    expect(await intentEvents(org.a)).toHaveLength(before + 1);

    const [row] = rows;
    const envelope = row.payload as {
      tenantId?: string;
      actor?: { type: string; id: string };
      aggregateType: string;
      payload: Record<string, unknown>;
    };
    expect(row.topic).toBe('rasta.document.v1');
    expect(row.partitionKey).toBe(issued.uploadIntentId);
    expect(row.organizationId).toBe(org.a);
    expect(envelope.tenantId).toBe(org.a);
    expect(envelope.actor).toEqual({ type: 'USER', id: 'USR-DOC-A' });
    expect(envelope.aggregateType).toBe('UploadIntent');
    expect(envelope.payload).toMatchObject({
      uploadIntentId: issued.uploadIntentId,
      organizationId: org.a,
      documentClass: 'CONTRACT',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 2048,
      requestedBy: 'USR-DOC-A',
      expiresAt: issued.expiresAt.toISOString(),
    });

    // Neither the object key nor the signed URL — a live write credential —
    // appears anywhere in what the log carries, nor does the filename.
    const intent = await intentRow(issued.uploadIntentId);
    const onTheWire = JSON.stringify(row.payload);
    expect(onTheWire).not.toContain(intent?.objectKey as string);
    expect(onTheWire).not.toContain(SIGNED_URL);
    expect(onTheWire).not.toContain('قرارداد');
  });

  it('rolls the intent and its event back together', async () => {
    const before = (await intentEvents(org.a)).length;
    const original = events.enqueue.bind(events);
    let intentId: string | undefined;
    // Fails *after* the outbox insert, inside the same transaction: if the two
    // writes were not atomic, one of them would survive.
    const spy = jest.spyOn(events, 'enqueue').mockImplementationOnce(async (tx, input) => {
      intentId = input.aggregateId;
      await original(tx, input);
      throw new Error('failure after the outbox insert');
    });

    try {
      await expect(request(org.a, 'USR-DOC-A')).rejects.toThrow('failure after the outbox insert');
    } finally {
      spy.mockRestore();
    }

    expect(intentId).toBeDefined();
    expect(await intentRow(intentId as string)).toBeNull();
    expect(await intentEvents(org.a)).toHaveLength(before);
  });

  it('files each tenant’s intent under that tenant only', async () => {
    const fromB = await request(org.b, 'USR-DOC-B');

    const underA = await intentEvents(org.a);
    const underB = await intentEvents(org.b);
    expect(underA.map((row) => row.aggregateId)).not.toContain(fromB.uploadIntentId);
    expect(underB.map((row) => row.aggregateId)).toContain(fromB.uploadIntentId);
    for (const row of underB) {
      expect((row.payload as { tenantId?: string }).tenantId).toBe(org.b);
    }
  });

  it('records nothing when the upload URL cannot be signed (Codex #114 R1-5)', async () => {
    // A failing signer: the caller gets an error, so the audit trail must not
    // say a permission was issued, and no intent may be left to redeem.
    const env = testEnv();
    const failing = {
      createUploadUrl: jest.fn(async () => {
        throw new Error('the signer is unavailable');
      }),
    } as unknown as ObjectStorage;
    const unsigned = new DocumentService(
      prisma,
      new DocumentRepository(prisma),
      events,
      env,
      failing,
    );
    const intentsBefore = await runUnscoped('assertions read the rows directly', () =>
      prisma.client.uploadIntent.count({ where: { organizationId: org.a } }),
    );
    const eventsBefore = (await intentEvents(org.a)).length;

    await expect(
      asActor({ organizationId: org.a, userId: 'USR-DOC-A' }, () =>
        unsigned.requestUploadUrl({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          filename: 'contract.pdf',
        }),
      ),
    ).rejects.toThrow('the signer is unavailable');

    expect(
      await runUnscoped('assertions read the rows directly', () =>
        prisma.client.uploadIntent.count({ where: { organizationId: org.a } }),
      ),
    ).toBe(intentsBefore);
    expect(await intentEvents(org.a)).toHaveLength(eventsBefore);
  });
});
