import { Kafka, type Consumer } from 'kafkajs';
import { OutboxRelay, runUnscoped, type EventEnvelope } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { SUPPLIER_TOPIC } from '../src/config/env';
import {
  asOperator,
  asSupplier,
  brokers,
  cleanup,
  newOrganizationId,
  outboxFor,
  waitFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * The event path, end to end, over a real broker.
 *
 * Every one of the four events this service produces is driven by a **domain
 * operation** — register, approve, reject, suspend — through the real services,
 * the real outbox, the real ADR-050 claim protocol and the real relay onto a
 * real Kafka topic. Nothing is enqueued by hand and no publisher is mocked.
 *
 * What this exists to prove, none of which a database-only test can:
 *
 *   - the topic is `rasta.supplier.v1` and the Kafka **message key** is the
 *     `supplierId`, so a partition holds one supplier's whole history;
 *   - the sequence ADR-051 B3 allocated survives the hop intact — the database
 *     column, the envelope field and the `x-stream-seq` header are three
 *     representations of one number, and a consumer reading any of them gets
 *     the same answer;
 *   - the four events arrive in per-supplier order;
 *   - tenant and correlation metadata survive publication, so an investigation
 *     that starts at a ledger entry can reach the request that caused it;
 *   - a stale claim cannot publish twice (ADR-050 fencing);
 *   - nothing is lost: every row written is a message delivered.
 *
 * `published_seq` is asserted **unchanged**. Advancing a head is ADR-051 B4,
 * which is not implemented, and a relay that moved it here would be claiming an
 * ordering guarantee the platform does not yet make.
 */

const brokerList = brokers();
// Skips rather than fails when no broker is configured: a developer without
// Docker should still be able to run the database half of the suite. A skip is
// visible in the output; silently passing is not.
const describeWithKafka = brokerList ? describe : describe.skip;

if (!brokerList) {
  console.warn('[event-flow] KAFKA_BROKERS is not set — skipping the broker tests');
}

interface Delivered {
  key: string | undefined;
  headers: Record<string, string>;
  envelope: EventEnvelope;
}

describeWithKafka('supplier event flow over Kafka', () => {
  const org = newOrganizationId();
  const platformOrg = newOrganizationId();
  const organizations = [org, platformOrg];
  const groupId = `supplier-itest-${ulid().slice(-12)}`;

  let wiring: Wiring;
  let prisma: PrismaService;
  let publisher: KafkaEventPublisher;
  let store: PrismaOutboxStore;
  let relay: OutboxRelay;
  let consumer: Consumer;

  const received: Delivered[] = [];

  /** Waits for a consumer to actually join its group, not merely for `run()`. */
  function groupJoin(target: Consumer, name: string): Promise<void> {
    // On a broker that has just started, `connect()`, `subscribe()` and `run()`
    // all succeed while the group coordinator is still unavailable: the
    // `__consumer_offsets` partitions have not finished loading. kafkajs then
    // retries in the background and the test publishes into a topic nobody is
    // reading yet, failing on a timeout that names the wrong thing.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Consumer group ${name} did not join within 60s`)),
        60_000,
      );
      target.on(target.events.GROUP_JOIN, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  beforeAll(async () => {
    wiring = wire();
    prisma = wiring.prisma;
    await prisma.onModuleInit();

    publisher = new KafkaEventPublisher({
      brokers: brokerList as string[],
      clientId: 'supplier-itest-producer',
    });
    store = new PrismaOutboxStore(prisma);
    relay = new OutboxRelay({ store, publisher });

    const kafka = new Kafka({
      clientId: 'supplier-itest',
      brokers: brokerList as string[],
      logLevel: 1,
    });

    // A dedicated consumer group per run, reading only what this run
    // publishes: the topic is shared with whatever else is on the machine.
    consumer = kafka.consumer({ groupId, sessionTimeout: 30_000 });
    const joined = groupJoin(consumer, groupId);
    await consumer.connect();
    await consumer.subscribe({ topic: SUPPLIER_TOPIC, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(message.headers ?? {})) {
          if (value) headers[name] = value.toString();
        }
        received.push({
          key: message.key?.toString(),
          headers,
          envelope: JSON.parse(message.value.toString('utf8')) as EventEnvelope,
        });
      },
    });
    await joined;

    await cleanup(prisma, organizations);
  }, 180_000);

  afterAll(async () => {
    await consumer?.disconnect();
    await publisher?.onModuleDestroy();
    await cleanup(prisma, organizations);
    await prisma?.onModuleDestroy();
  }, 60_000);

  /** Every message this run delivered for one supplier, in arrival order. */
  const deliveredFor = (supplierId: string): Delivered[] =>
    received.filter(
      (message) => (message.envelope.payload as { supplierId?: string }).supplierId === supplierId,
    );

  it('carries all four events to the topic, keyed by supplierId and in order', async () => {
    // --- drive the domain, not the outbox -----------------------------------
    const supplier = await asSupplier(org, () =>
      wiring.suppliers.register({
        displayName: 'کارگاه رویدادی',
        capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
      } as never),
    );

    const approved = await asSupplier(org, () =>
      wiring.qualifications.submit(supplier.id, {
        capability: 'WORKSHOP_SERVICE',
        statement: 'we service loaders',
        evidence: [],
      } as never),
    );
    await asOperator(
      () =>
        wiring.qualifications.decide(supplier.id, approved.id, 'APPROVED', {
          note: 'checked',
        } as never),
      platformOrg,
    );

    const rejected = await asSupplier(org, () =>
      wiring.qualifications.submit(supplier.id, {
        capability: 'GOODS_SUPPLY',
        statement: 'we also supply gravel',
        evidence: [],
      } as never),
    );
    await asOperator(
      () =>
        wiring.qualifications.decide(supplier.id, rejected.id, 'REJECTED', {
          reason: 'no evidence of supply capacity',
        } as never),
      platformOrg,
    );

    await asOperator(
      () => wiring.suspensions.suspend(supplier.id, { reason: 'under review' } as never),
      platformOrg,
    );

    // --- four rows in the outbox, none published yet -------------------------
    const pending = await outboxFor(prisma, org);
    expect(pending).toHaveLength(4);
    expect(pending.every((row) => row.publishedAt === null)).toBe(true);

    // --- the real relay, on the real broker ----------------------------------
    relay.start();
    try {
      await waitFor(
        () => (deliveredFor(supplier.id).length >= 4 ? true : undefined),
        'the relay to deliver all four supplier events',
        60_000,
      );
    } finally {
      await relay.stop();
    }

    const delivered = deliveredFor(supplier.id);
    expect(delivered).toHaveLength(4);

    // Every message on this supplier's stream is keyed by the supplier, not by
    // the aggregate the event is about — a qualification, a suspension. That is
    // what puts one supplier's whole history on one partition.
    for (const message of delivered) {
      expect(message.key).toBe(supplier.id);
      expect(message.envelope.streamKey).toBe(supplier.id);
    }
    expect(new Set(delivered.map((message) => message.envelope.aggregateId)).size).toBe(4);

    // Per-supplier order, as produced.
    expect(delivered.map((message) => message.envelope.eventName)).toEqual([
      'SUPPLIER_REGISTERED',
      'SUPPLIER_QUALIFIED',
      'SUPPLIER_REJECTED',
      'SUPPLIER_SUSPENDED',
    ]);
    expect(delivered.map((message) => message.envelope.streamSeq)).toEqual([1, 2, 3, 4]);

    // --- the three representations of one sequence agree ---------------------
    const rows = await outboxFor(prisma, org);
    const bySeq = new Map(rows.map((row) => [Number(row.streamSeq), row]));
    for (const message of delivered) {
      const seq = message.envelope.streamSeq as number;
      const row = bySeq.get(seq);
      expect(row).toBeDefined();
      // database column === envelope field === header, byte for byte on the wire
      expect(Number(row!.streamSeq)).toBe(seq);
      expect(message.headers['x-stream-seq']).toBe(String(seq));
      expect(message.envelope.eventId).toBe(row!.id);
    }

    // --- tenant and correlation survive the hop ------------------------------
    for (const message of delivered) {
      expect(message.headers['x-tenant-id']).toBe(org);
      expect(message.headers['x-producer']).toBe('supplier-service');
      const row = bySeq.get(message.envelope.streamSeq as number)!;
      expect(message.envelope.correlationId).toBe(row.correlationId);
      expect(message.headers['x-correlation-id']).toBe(row.correlationId);
    }

    // --- nothing lost, nothing left ------------------------------------------
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.publishedAt !== null)).toBe(true);
    expect(rows.every((row) => row.lastError === null)).toBe(true);

    // A published row holds no claim. `ck_outbox_published_is_clean` says so at
    // the storage layer; this says the relay actually leaves it that way.
    expect(rows.every((row) => row.claimToken === null)).toBe(true);
    expect(rows.every((row) => row.claimExpiresAt === null)).toBe(true);

    // --- B4 is absent, and must look absent ----------------------------------
    const counters = await runUnscoped('reading this service own stream counter', () =>
      prisma.client.outboxStreamSequence.findMany({ where: { partitionKey: supplier.id } }),
    );
    expect(counters).toHaveLength(1);
    expect(counters[0].topic).toBe(SUPPLIER_TOPIC);
    // The next allocation continues at 5; nothing advanced the head.
    expect(Number(counters[0].nextSeq)).toBe(5);
    expect(Number(counters[0].publishedSeq)).toBe(0);
    expect(rows.every((row) => row.isStreamHead === false)).toBe(true);
  }, 240_000);

  it('refuses a stale claim, so a slow relay cannot publish a row twice', async () => {
    // Its own organization: `supplier.organization_id` is unique, so this case
    // cannot reuse the one the flow test registered in.
    const claimOrg = newOrganizationId();
    organizations.push(claimOrg);

    const supplier = await asSupplier(claimOrg, () =>
      wiring.suppliers.register({
        displayName: 'کارگاه انحصار',
        capabilities: ['CONTRACTING'],
      } as never),
    );

    const [row] = await outboxFor(prisma, claimOrg);
    expect(row.publishedAt).toBeNull();

    // `claimPending` takes the oldest rows **table-wide** — it has no tenant
    // filter, by design, because a relay serves the whole database. So this
    // assertion is only about this suite if this suite owns every pending row.
    //
    // Checked rather than assumed. If another process is writing to
    // `rasta_supplier` — a live `pnpm dev` instance, an overlapping run — the
    // batch below may not contain this row, and the failure would look like an
    // ADR-050 defect while being nothing of the kind. Failing here instead names
    // the real condition. (Same shape as the audit's F-01 and F-21; the general
    // remedy is a separate change, not this PR's.)
    const foreign = await runUnscoped('checking this suite owns the pending backlog', () =>
      prisma.client.outboxMessage.findMany({
        where: { publishedAt: null, organizationId: { notIn: organizations } },
        select: { id: true, organizationId: true },
        take: 5,
      }),
    );
    if (foreign.length > 0) {
      throw new Error(
        'Another process left unpublished rows in rasta_supplier ' +
          `(${foreign.map((row) => row.organizationId).join(', ')}). ` +
          'claimPending is table-wide, so this ADR-050 assertion cannot be trusted. ' +
          'Stop any running supplier-service instance or concurrent run and retry — ' +
          'this is a harness condition, not a supplier defect.',
      );
    }

    // Two relays claim; ADR-050 gives the row to exactly one, and the token the
    // database wrote is the fence. The loser must not be able to acknowledge it.
    const first = await store.claimPending({ limit: 10, owner: 'relay-a', leaseSeconds: 30 });
    expect(first.rows.map((claimed) => claimed.id)).toContain(row.id);
    expect(first.token).not.toBeNull();

    const second = await store.claimPending({ limit: 10, owner: 'relay-b', leaseSeconds: 30 });
    expect(second.rows.map((entry) => entry.id)).not.toContain(row.id);

    // A stale token — what a relay holds after its lease was reclaimed, and
    // what its own *next* claim would carry — must acknowledge nothing.
    expect(await store.markPublished([row.id], `${first.token}-stale`)).toBe(0);
    if (second.token) {
      expect(await store.markPublished([row.id], second.token)).toBe(0);
    }

    const stillPending = await runUnscoped('reading the row back', () =>
      prisma.client.outboxMessage.findUniqueOrThrow({ where: { id: row.id } }),
    );
    expect(stillPending.publishedAt).toBeNull();

    // The real token works, and works exactly once: a redelivery cannot publish
    // the same row twice.
    expect(await store.markPublished([row.id], first.token as string)).toBe(1);
    expect(await store.markPublished([row.id], first.token as string)).toBe(0);

    const published = await runUnscoped('reading the published row back', () =>
      prisma.client.outboxMessage.findUniqueOrThrow({ where: { id: row.id } }),
    );
    expect(published.publishedAt).not.toBeNull();
    expect(published.claimToken).toBeNull();
  }, 120_000);
});
