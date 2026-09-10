import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import { CHAIN_HASH_BYTES } from '../src/audit/audit.chain';
import { cleanupRun, id, newMigratorPrisma, newPrismaWithPool, runConcurrently } from './helpers';

/**
 * A thousand concurrent writers, and the one property that makes the chain
 * evidence: it does not fork (ADR-053 § 6, acceptance matrix in
 * `docs/adr/ADR-053-implementation-plan.md`).
 *
 * ## Why this suite cannot be a unit test
 *
 * The whole design of `AuditRepository.ingest` is a claim about PostgreSQL:
 * that `SELECT … FOR UPDATE` on the head row serialises the assignment of
 * `previous_hash`, that `nextval` drawn under that lock makes `sequence_no`
 * ascending equal chain order, and that `INSERT … ON CONFLICT DO NOTHING`
 * waits for a concurrent creator rather than returning to a row that is not
 * there yet. Every one of those is a property of the server. A mock would
 * assert that the code intends them, which is exactly the assertion that
 * passes while production forks.
 *
 * ## What a fork looks like, and why counting rows would miss it
 *
 * Two writers that read the same tip both write `previous_hash = H`. Both rows
 * exist, both hash correctly, the row count is right, and the chain is
 * silently a tree — one of the two branches can be removed later with nothing
 * to notice. So the assertions below are about *links*, not about counts: one
 * record with no predecessor, every later record naming the record before it,
 * and no predecessor named twice.
 *
 * ## Three chains, deliberately unequal
 *
 * Contention is the subject, so one chain takes most of the load and the other
 * two take enough to race each other into existence — the `ON CONFLICT`
 * path, which only runs when two writers try to open the same chain at once.
 * Different tenants, so the three chain keys are genuinely independent and the
 * suite also shows that load on one does not disturb another.
 */

/** How many of the thousand land on the contended chain. */
const CONTENDED_WRITES = 800;
/** And on each of the two chains that race each other into existence. */
const OPENING_WRITES = 100;

const TOTAL_WRITES = CONTENDED_WRITES + OPENING_WRITES * 2;

/**
 * The pool, and the number of writers allowed to hold one at once.
 *
 * A writer blocked on the head's row lock is holding a connection, so these two
 * numbers decide how many writers actually meet at the lock. The in-flight
 * limit is one below the pool so a queued call never waits on the pool instead
 * of on the chain.
 *
 * ## Why the thousand are not all launched at once
 *
 * They cannot be, and the reason is a property of the product rather than of
 * this file. `AuditRepository.ingest` opens an interactive transaction and
 * takes the chain head's row lock inside it, so a writer on a contended chain
 * spends nearly all of `INGEST_TRANSACTION.timeout` waiting for that lock.
 * Every waiter past the ceiling aborts with `Transaction already closed`,
 * which says nothing about the chain.
 *
 * Measured on this workstation (PostgreSQL 16 in Docker Desktop): a write
 * transaction costs ~85ms, almost all of it the commit's WAL flush, and the
 * cost does not fall with concurrency because one chain's writers are
 * serialised by design. Twelve in flight therefore queue for roughly a second,
 * which fits inside the bound with room for a checkpoint — the margin the
 * default five-second ceiling did not leave, and the reason `ingest` now
 * states its bounds instead of inheriting them.
 *
 * The limit shapes how deep the queue gets and nothing else: the assertions
 * below are about links, and twelve genuinely simultaneous writers on one
 * chain is already far more than one fork needs.
 */
const POOL_CONNECTIONS = 13;
const IN_FLIGHT = POOL_CONNECTIONS - 1;

/**
 * A month with a real partition, so the writes exercise the pruned path rather
 * than `audit_event_default`. The chains are told apart by tenant, and every
 * tenant identifier carries the run tag, so the three keys cannot collide with
 * another run's.
 */
const CHAIN_MONTH = '2027-05-01';
const monthStart = new Date(`${CHAIN_MONTH}T00:00:00.000Z`);
const monthEnd = new Date('2027-06-01T00:00:00.000Z');

interface ChainRow {
  id: string;
  sequenceNo: bigint;
  recordHash: Uint8Array | null;
  previousHash: Uint8Array | null;
}

interface HeadRow {
  chain_length: bigint;
  head_hash: Uint8Array | null;
  head_event_id: string | null;
  head_sequence_no: bigint | null;
  first_sequence_no: bigint | null;
}

const hex = (value: Uint8Array | null): string | null =>
  value === null ? null : Buffer.from(value).toString('hex');

describe('the hash chain under concurrent ingestion (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;

  /** The contended chain, seeded before the storm so its opening is known. */
  const contended = id('ORG-CONTENDED');
  /** The two chains the storm has to open for itself. */
  const openingA = id('ORG-OPENING-A');
  const openingB = id('ORG-OPENING-B');

  /** `first_sequence_no` as it stood before the thousand writers arrived. */
  let contendedOpening: bigint;

  const delivery: EventDelivery = Object.freeze({ topic: 'rasta.asset.v1', partition: 0 });

  function envelope(tenantId: string, minute: number): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName: 'ASSET_DECOMMISSIONED',
      eventVersion: 1,
      // Spread across the month, and never all identical: chain order is
      // `sequence_no`, not `occurred_at`, and rows that differ in both are what
      // proves the walk follows the chain rather than the clock.
      occurredAt: new Date(monthStart.getTime() + minute * 1000).toISOString(),
      producer: 'asset-service',
      producerVersion: '1.0.0',
      aggregateType: 'Asset',
      aggregateId: id('AST'),
      tenantId,
      correlationId: id('COR'),
      payload: {},
    } as EventEnvelope;
  }

  const ingestOne = (tenantId: string, minute: number) => async (): Promise<string> =>
    await repository.ingest(
      toAuditEventRecord(envelope(tenantId, minute), delivery),
      DOMAIN_PROJECTOR_CONSUMER,
    );

  /** One chain's records, tenant-and-month scoped, in chain order. */
  async function chainOf(organizationId: string): Promise<ChainRow[]> {
    return await prisma.client.auditEvent.findMany({
      where: {
        organizationId,
        occurredAt: { gte: monthStart, lt: monthEnd },
      },
      orderBy: { sequenceNo: 'asc' },
      select: { id: true, sequenceNo: true, recordHash: true, previousHash: true },
    });
  }

  async function headOf(organizationId: string): Promise<HeadRow> {
    const rows = await prisma.client.$queryRawUnsafe<HeadRow[]>(
      `SELECT chain_length, head_hash, head_event_id, head_sequence_no, first_sequence_no
         FROM audit_chain_head
        WHERE chain_scope = 'ORGANIZATION'::audit_chain_scope
          AND organization_id = $1
          AND chain_month = $2::date`,
      organizationId,
      CHAIN_MONTH,
    );
    const head = rows[0];
    if (!head) throw new Error(`no chain head for ${organizationId}/${CHAIN_MONTH}`);
    return head;
  }

  beforeAll(async () => {
    prisma = newPrismaWithPool(POOL_CONNECTIONS);
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    repository = new AuditRepository(prisma);

    // One record first, alone, so the contended chain's segment start is a
    // known value before anything races. Nothing below may move it.
    expect(await ingestOne(contended, 0)()).toBe('WRITTEN');
    contendedOpening = (await headOf(contended)).first_sequence_no as bigint;
    expect(contendedOpening).not.toBeNull();

    const tasks = [
      ...Array.from({ length: CONTENDED_WRITES }, (_, index) => ingestOne(contended, index + 1)),
      ...Array.from({ length: OPENING_WRITES }, (_, index) => ingestOne(openingA, index + 1)),
      ...Array.from({ length: OPENING_WRITES }, (_, index) => ingestOne(openingB, index + 1)),
    ];
    // Interleaved rather than run chain by chain, so the two chains that have
    // to open themselves do so while the contended one is under load.
    tasks.sort(() => Math.random() - 0.5);

    const outcomes = await runConcurrently(tasks, IN_FLIGHT);

    // Every one of the thousand was a genuine write. A `DUPLICATE` here would
    // mean two calls collided on an event id, which would make every count
    // below prove less than it appears to.
    expect(outcomes).toHaveLength(TOTAL_WRITES);
    expect(outcomes.filter((outcome) => outcome === 'WRITTEN')).toHaveLength(TOTAL_WRITES);
  }, 600_000);

  afterAll(async () => {
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 600_000);

  describe.each([
    ['the contended chain', () => contended, CONTENDED_WRITES + 1],
    ['a chain the storm opened', () => openingA, OPENING_WRITES],
    ['the other chain the storm opened', () => openingB, OPENING_WRITES],
  ])('%s', (_label, organization, expectedRows) => {
    it('wrote every record exactly once', async () => {
      const rows = await chainOf(organization());
      expect(rows).toHaveLength(expectedRows);
      expect(new Set(rows.map((row) => row.id)).size).toBe(expectedRows);
    });

    it('has exactly one first link, and every other record names the one before it', async () => {
      const rows = await chainOf(organization());

      const opening = rows.filter((row) => row.previousHash === null);
      expect(opening).toHaveLength(1);
      // And it is the first position in the chain, not merely one of them.
      expect(opening[0]?.sequenceNo).toBe(rows[0]?.sequenceNo);

      for (const [index, row] of rows.entries()) {
        expect(row.recordHash).not.toBeNull();
        expect(row.recordHash?.length).toBe(CHAIN_HASH_BYTES);
        expect(hex(row.previousHash)).toBe(index === 0 ? null : hex(rows[index - 1]!.recordHash));
      }
    });

    it('never forked: no predecessor is claimed twice', async () => {
      // The failure a row count cannot see. Two writers that read the same tip
      // both produce a valid-looking record whose `previous_hash` is the same
      // digest, and the chain becomes a tree.
      const rows = await chainOf(organization());

      const predecessors = rows.map((row) => hex(row.previousHash)).filter((h) => h !== null);
      expect(new Set(predecessors).size).toBe(predecessors.length);

      const digests = rows.map((row) => hex(row.recordHash));
      expect(new Set(digests).size).toBe(digests.length);
    });

    it('has a head that counts and names the actual tail', async () => {
      const rows = await chainOf(organization());
      const head = await headOf(organization());
      const tail = rows[rows.length - 1]!;

      expect(head.chain_length).toBe(BigInt(rows.length));
      expect(head.head_event_id).toBe(tail.id);
      expect(head.head_sequence_no).toBe(tail.sequenceNo);
      expect(hex(head.head_hash)).toBe(hex(tail.recordHash));
      expect(head.first_sequence_no).toBe(rows[0]!.sequenceNo);
    });

    it('is ordered by sequence_no, which never repeats inside it', async () => {
      // Deliberately not a claim that `sequence_no` is gapless. It is drawn
      // from one cluster-wide sequence shared by every chain, so the values in
      // one chain are ascending and full of holes — the holes are the other
      // chains' records, and a test that demanded contiguity would be asserting
      // that no other tenant ever writes.
      const rows = await chainOf(organization());
      const sequences = rows.map((row) => row.sequenceNo);

      expect(new Set(sequences.map(String)).size).toBe(sequences.length);
      for (let index = 1; index < sequences.length; index += 1) {
        expect(sequences[index]! > sequences[index - 1]!).toBe(true);
      }
    });
  });

  it('never moved the contended chain’s segment start', async () => {
    // `first_sequence_no` was written by the single record ingested before the
    // storm. Eight hundred concurrent writers later it must be that same value:
    // moving it forward would reclassify every record between the old and new
    // value as pre-chain legacy, which is how a deleted link would be laundered
    // past the verifier.
    const head = await headOf(contended);
    expect(head.first_sequence_no).toBe(contendedOpening);
  });

  it('kept the three chains independent of one another', async () => {
    // Separate heads, separate lengths, and no record of one tenant in
    // another's chain. This is the reason ADR-053 § 6 scopes a chain per
    // tenant-month instead of using one global chain.
    const [a, b, c] = await Promise.all([chainOf(contended), chainOf(openingA), chainOf(openingB)]);

    const digestsOf = (rows: ChainRow[]): Set<string | null> =>
      new Set(rows.map((row) => hex(row.recordHash)));

    for (const [left, right] of [
      [a, b],
      [a, c],
      [b, c],
    ] as const) {
      const overlap = [...digestsOf(left)].filter((digest) => digestsOf(right).has(digest));
      expect(overlap).toEqual([]);
    }

    expect(a).toHaveLength(CONTENDED_WRITES + 1);
    expect(b).toHaveLength(OPENING_WRITES);
    expect(c).toHaveLength(OPENING_WRITES);
  });
});
