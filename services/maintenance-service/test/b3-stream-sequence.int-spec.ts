import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the allocator. This
 * proves *maintenance* uses it: a real domain operation commits outbox rows
 * whose persisted `stream_seq`, envelope `streamSeq`, envelope `streamKey` and
 * `x-stream-seq` header all agree, and this service's own routing policy
 * decided the stream.
 *
 * Maintenance needs its own evidence for the reason ADR-051 § R4 recorded: its
 * only domain lock is on `repair_order`, **not** on the `assetId` boundary the
 * stream is keyed by. The counter row taken inside the domain transaction is
 * therefore its serialisation point, and nothing else is.
 */
describe('maintenance stream sequencing', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let requests: RequestService;

  beforeAll(() => {
    prisma = newPrisma();
    repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const outboxFor = (assetId: string) =>
    asActor({ organizationId: org.a }, () =>
      repository.client.outboxMessage.findMany({
        where: { partitionKey: assetId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  /** The four places a sequence appears must all carry the same value. */
  const assertConsistent = (row: {
    partitionKey: string;
    streamSeq: bigint | null;
    payload: unknown;
    headers: unknown;
  }) => {
    const envelope = row.payload as { streamSeq?: number; streamKey?: string };
    const headers = row.headers as Record<string, string>;

    expect(row.streamSeq).not.toBeNull();
    const persisted = Number(row.streamSeq);
    expect(envelope.streamSeq).toBe(persisted);
    expect(envelope.streamKey).toBe(row.partitionKey);
    expect(headers['x-stream-seq']).toBe(String(persisted));
    return persisted;
  };

  it('sequences both events of one report against the asset stream', async () => {
    const assetId = id('AST-B3');
    await seedAsset(prisma, assetId, org.a);

    // One real domain operation that emits two events — the case where a gap
    // or a repeat would be most visible.
    const request = await asActor({ organizationId: org.a }, () =>
      requests.create({
        assetId,
        type: 'CORRECTIVE',
        severity: 'HIGH',
        title: 'نشتی روغن',
      }),
    );
    expect(request.id).toBeDefined();

    const rows = await outboxFor(assetId);
    expect(rows.map((row) => row.eventName)).toEqual([
      'BREAKDOWN_REPORTED',
      'MAINTENANCE_CREATED',
    ]);

    // Both on the asset stream, from `routing.ts` rather than the call site,
    // and numbered 1 then 2 with no gap between them.
    expect(rows.every((row) => row.topic === 'rasta.maintenance.v1')).toBe(true);
    expect(rows.map(assertConsistent)).toEqual([1, 2]);

    // The counter is this service's own, positioned where the next allocation
    // continues. `published_seq` has not moved: advancing it is B4.
    const counters = await asActor({ organizationId: org.a }, () =>
      repository.client.$queryRawUnsafe<
        { topic: string; next_seq: bigint; published_seq: bigint }[]
      >(
        `SELECT "topic", "next_seq", "published_seq"
           FROM "outbox_stream_sequence" WHERE "partition_key" = $1`,
        assetId,
      ),
    );
    expect(counters).toHaveLength(1);
    expect(counters[0].topic).toBe('rasta.maintenance.v1');
    expect(Number(counters[0].next_seq)).toBe(3);
    expect(Number(counters[0].published_seq)).toBe(0);
  });

  it('gives a second machine its own count, starting at 1', async () => {
    const assetId = id('AST-B3B');
    await seedAsset(prisma, assetId, org.a);

    await asActor({ organizationId: org.a }, () =>
      requests.create({
        assetId,
        // Same shape as the first machine: the point here is the *counter*,
        // and `ck_request_severity_matches_type` constrains which severities a
        // PREVENTIVE request may carry.
        type: 'CORRECTIVE',
        severity: 'MEDIUM',
        title: 'سرویس دوره‌ای',
      }),
    );

    const rows = await outboxFor(assetId);
    // A different machine is a different stream. If the two shared a counter,
    // this would start where the previous test left off.
    expect(rows.map(assertConsistent)).toEqual([1, 2]);
  });
});
