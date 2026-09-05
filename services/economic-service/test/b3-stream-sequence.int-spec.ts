import { asActor, cleanup, fundWallet, newPrisma, tenants, wire } from './helpers';
import type { Wiring } from './helpers';
import { runUnscoped } from '@rasta/nest-common';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the allocator. This
 * proves *economic* uses it: a real domain operation commits an outbox row
 * whose persisted `stream_seq`, envelope `streamSeq`, envelope `streamKey` and
 * `x-stream-seq` header all agree, keyed by the stream `routing.ts` chose.
 *
 * This is the service the ordering problem was found in. ADR-036 § Q-26
 * happened here — a transaction's events scattered across four partitions
 * because the key was a suggestion rather than a rule — and
 * `rasta.economic.v1 + transactionId` is the last STRICT stream in the § 4
 * rollout order precisely because it is financial.
 */
describe('economic stream sequencing', () => {
  const org = tenants();
  let prisma: PrismaService;
  let wiring: Wiring;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

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

  const outbox = () =>
    runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({ orderBy: { createdAt: 'asc' } }),
    );

  it('funds a wallet and commits sequenced rows on the streams routing chose', async () => {
    const before = (await outbox()).length;
    await fundWallet(wiring, org.a, 5_000_000n);

    const rows = (await outbox()).slice(before);
    expect(rows.length).toBeGreaterThan(0);

    // Every row this operation wrote is sequenced and internally consistent.
    for (const row of rows) {
      expect(row.topic).toBe('rasta.economic.v1');
      assertConsistent(row);
    }

    // And each distinct stream counts independently from 1 — the property
    // ADR-036 § Q-26 was about.
    const perStream = new Map<string, number[]>();
    for (const row of rows) {
      const seqs = perStream.get(row.partitionKey) ?? [];
      seqs.push(Number(row.streamSeq));
      perStream.set(row.partitionKey, seqs);
    }
    for (const [key, seqs] of perStream) {
      expect(seqs).toEqual(seqs.map((_value, index) => index + 1));
      expect(key).not.toHaveLength(0);
    }

    // The counter rows live in this service's own database, and none has had
    // its published_seq advanced — that is B4.
    const counters = await runUnscoped('reads platform plumbing', () =>
      prisma.client.$queryRawUnsafe<{ topic: string; published_seq: bigint }[]>(
        `SELECT "topic", "published_seq" FROM "outbox_stream_sequence"`,
      ),
    );
    expect(counters.length).toBeGreaterThan(0);
    expect(counters.every((counter) => counter.topic === 'rasta.economic.v1')).toBe(true);
    expect(counters.every((counter) => Number(counter.published_seq) === 0)).toBe(true);
  });
});
