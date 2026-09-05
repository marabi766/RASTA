import { runUnscoped } from '@rasta/nest-common';
import { OrganizationRepository } from '../src/organization/organization.repository';
import { OrganizationService } from '../src/organization/organization.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma, tenants } from './helpers';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the allocator. This
 * proves *organization* uses it: a real domain operation commits an outbox row
 * whose persisted `stream_seq`, envelope `streamSeq`, envelope `streamKey` and
 * `x-stream-seq` header all agree, keyed by the stream `routing.ts` chose.
 *
 * DETECT class under ADR-051 § D-1: nothing blocks on a gap here, but a
 * consumer rebuilding an organization needs to be able to *see* one, which is
 * what an allocated sequence gives it.
 */
describe('organization stream sequencing', () => {
  const org = tenants();
  let prisma: PrismaService;
  let organizations: OrganizationService;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    // Warm the connection and the query engine before the first transaction.
    // Prisma's interactive transactions time out at 5s, and under a loaded
    // full-suite run the first one was paying engine start-up inside that
    // budget — measuring cold start rather than anything about sequencing.
    await prisma.client.$queryRawUnsafe('SELECT 1');
    organizations = new OrganizationService(new OrganizationRepository(prisma), 6);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const assertConsistent = (row: {
    partitionKey: string;
    streamSeq: bigint | null;
    payload: unknown;
    headers: unknown;
  }): number => {
    const envelope = row.payload as { streamSeq?: number; streamKey?: string };
    const headers = row.headers as Record<string, string>;

    expect(row.streamSeq).not.toBeNull();
    const persisted = Number(row.streamSeq);
    expect(envelope.streamSeq).toBe(persisted);
    expect(envelope.streamKey).toBe(row.partitionKey);
    expect(headers['x-stream-seq']).toBe(String(persisted));
    return persisted;
  };

  const outboxFor = (aggregateId: string) =>
    runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  it('creates an organization and commits a sequenced row keyed by it', async () => {
    const created = await asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
      organizations.create({
        name: 'دهیاری آزمون B3',
        type: 'DEHYARI',
        metadata: {},
      } as never),
    );

    const rows = await outboxFor(created.id);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.topic).toBe('rasta.organization.v1');
      // Aggregate-scoped, now stated in `routing.ts` rather than left to the
      // `buildOutboxRow` default.
      expect(row.partitionKey).toBe(created.id);
      assertConsistent(row);
    }
    expect(rows.map((row) => Number(row.streamSeq))).toEqual(rows.map((_row, index) => index + 1));
  });
});
