import {
  asActor,
  cleanup,
  id,
  newPrisma,
  outboxFor,
  putToSignedUrl,
  tenants,
  wire,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { Wiring } from './helpers';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the allocator. This
 * proves *document* uses it: a real domain operation commits an outbox row
 * whose persisted `stream_seq`, envelope `streamSeq`, envelope `streamKey` and
 * `x-stream-seq` header all agree, keyed by the stream this service's own
 * `routing.ts` chose.
 *
 * `rasta.document.v1 + documentId` is the first STRICT stream in the ADR-051
 * § 4 rollout order, which is why its evidence is its own file rather than a
 * line in the shared suite.
 */
describe('document stream sequencing', () => {
  const org = tenants();
  let prisma: PrismaService;
  let wiring: Wiring;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    wiring = wire(prisma);
    await cleanup(prisma, [org.a, org.b], wiring.storage);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b], wiring.storage);
    await prisma.onModuleDestroy();
  });

  /**
   * The four places a sequence appears must all carry the same value, and the
   * key must be the one the row is partitioned by.
   */
  function assertConsistent(row: {
    partitionKey: string;
    streamSeq: bigint | null;
    payload: unknown;
    headers: unknown;
  }): number {
    const envelope = row.payload as { streamSeq?: number; streamKey?: string };
    const headers = row.headers as Record<string, string>;

    expect(row.streamSeq).not.toBeNull();
    const persisted = Number(row.streamSeq);
    expect(envelope.streamSeq).toBe(persisted);
    expect(envelope.streamKey).toBe(row.partitionKey);
    expect(headers['x-stream-seq']).toBe(String(persisted));
    return persisted;
  }

  it('uploads a document and commits a sequenced row keyed by the document', async () => {
    const asOrgA = <T>(fn: () => Promise<T>) =>
      asActor({ organizationId: org.a, userId: `USR-B3-${id('X').slice(-6)}` }, fn);

    const bytes = Buffer.from('%PDF-1.4 b3 evidence');
    const intent = await asOrgA(() =>
      wiring.documents.requestUploadUrl({
        documentClass: 'CONTRACT',
        contentType: 'application/pdf',
        sizeBytes: bytes.length,
        filename: 'b3.pdf',
      }),
    );
    const put = await putToSignedUrl(intent.uploadUrl, bytes, 'application/pdf');
    expect(put).toBe(200);

    const document = await asOrgA(() =>
      wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId }),
    );

    const rows = (await outboxFor(prisma, org.a)).filter((row) => row.aggregateId === document.id);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.topic).toBe('rasta.document.v1');
      // Keyed by the document, from `routing.ts`.
      expect(row.partitionKey).toBe(document.id);
      assertConsistent(row);
    }

    // Dense and starting at 1: this document's stream is new.
    expect(rows.map((row) => Number(row.streamSeq))).toEqual(rows.map((_row, index) => index + 1));
  });
});
