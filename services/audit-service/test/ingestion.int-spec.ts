import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { SENSITIVE_KEYS } from '@rasta/logging';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import type { OrganizationProjection } from '../src/audit/organization-projection';
import { CHAIN_HASH_BYTES, computeRecordHash, hashesEqual } from '../src/audit/audit.chain';
import {
  cleanupRun,
  id,
  instantIn,
  newMigratorPrisma,
  newPrisma,
  runMonth,
  RUN_TAG,
} from './helpers';

/**
 * What actually lands in the database when an envelope is ingested.
 *
 * Against real PostgreSQL because every claim here is a database claim: the
 * generated timestamp, the transaction boundary, the unique index and which
 * partition a row routes to are all properties of the server, and a mock would
 * assert only that the code intends them.
 */
describe('domain-event ingestion (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;

  const delivery = (topic = 'rasta.asset.v1'): EventDelivery =>
    Object.freeze({ topic, partition: 0 });

  function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName: 'ASSET_DECOMMISSIONED',
      eventVersion: 1,
      occurredAt: '2026-11-20T14:05:00.000Z',
      producer: 'asset-service',
      producerVersion: '2.1.0',
      aggregateType: 'Asset',
      aggregateId: id('AST'),
      tenantId: id('ORG'),
      correlationId: id('COR'),
      payload: { reason: 'sold', password: 'hunter2' },
      ...overrides,
    } as EventEnvelope;
  }

  /** One chain head, read as the row the database actually holds. */
  interface ChainHeadRow {
    chain_length: bigint;
    head_hash: Uint8Array | null;
    head_event_id: string | null;
    head_sequence_no: bigint | null;
    first_sequence_no: bigint | null;
  }

  async function headOf(organizationId: string | null, chainMonth: string): Promise<ChainHeadRow> {
    const rows = await prisma.client.$queryRawUnsafe<ChainHeadRow[]>(
      `SELECT chain_length, head_hash, head_event_id, head_sequence_no, first_sequence_no
         FROM audit_chain_head
        WHERE chain_scope = $1::audit_chain_scope
          AND organization_id = $2
          AND chain_month = $3::date`,
      organizationId === null ? 'PLATFORM' : 'ORGANIZATION',
      organizationId ?? '',
      chainMonth,
    );
    const head = rows[0];
    if (!head) throw new Error(`no chain head for ${organizationId ?? '(platform)'}/${chainMonth}`);
    return head;
  }

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    repository = new AuditRepository(prisma);
  }, 60_000);

  afterAll(async () => {
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 60_000);

  it('stores the mapped record with database-generated recorded_at', async () => {
    const source = envelope({ causationId: id('CAU'), traceparent: '00-aa-bb-01', streamSeq: 7 });
    const record = toAuditEventRecord(source, delivery());

    const before = new Date();
    expect(await repository.ingest(record, DOMAIN_PROJECTOR_CONSUMER)).toBe('WRITTEN');
    const after = new Date();

    const row = await prisma.client.auditEvent.findFirstOrThrow({
      where: { sourceEventId: source.eventId },
    });

    // The domain time is preserved exactly; the recording time is the
    // database's. The gap between them is the lag metric, which is why neither
    // may be derived from the other.
    expect(row.occurredAt.toISOString()).toBe('2026-11-20T14:05:00.000Z');
    expect(row.recordedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.recordedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    expect(row.recordedAt.getTime()).not.toBe(row.occurredAt.getTime());

    expect(row.actorType).toBe('SYSTEM');
    expect(row.actorId).toBe('asset-service');
    expect(row.actorRoles).toEqual([]);
    expect(row.organizationId).toBe(source.tenantId);
    expect(row.sourceTopic).toBe('rasta.asset.v1');
    expect(row.sourceStreamSeq).toBe(7n);
    expect(row.outcome).toBe('SUCCESS');
  });

  it('never persists the payload, so a secret in it cannot reach the store', async () => {
    // The envelope above carries `password: 'hunter2'`. AUD-001 stores no
    // payload at all, and this asserts the row proves it rather than trusting
    // the mapper.
    const source = envelope({ payload: { password: 'hunter2', token: 'eyJ' } });
    await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER);

    const row = await prisma.client.auditEvent.findFirstOrThrow({
      where: { sourceEventId: source.eventId },
    });

    expect(row.changes).toBeNull();
    // BigInt columns (`sequenceNo`, `sourceStreamSeq`) make a plain
    // JSON.stringify throw, so the row is flattened to text explicitly.
    const asText = JSON.stringify(row, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(asText).not.toContain('hunter2');
    expect(asText).not.toContain('eyJ');
  });

  it('retains an undeclared event name while storing none of its sensitive values', async () => {
    // The acceptance sentence AUD-001 actually satisfies (ADR-053
    // implementation plan § 2.1). Both halves matter and they pull in opposite
    // directions: the event must be *kept* even though nothing declares its
    // name, and its payload must *not* be — path A cannot build the bounded
    // redacted delta ADR-053 § 5 permits, and a raw blob would put sealed bid
    // data into the one table nobody may delete from (S-09, "no raw payload").
    //
    // Built from **every** entry in `SENSITIVE_KEYS`, one distinct sentinel
    // each, so a key added to `@rasta/logging` tomorrow is covered here the
    // moment it is declared rather than quietly going untested. The unit suite
    // asserts the same invariant on the mapped record; this asserts it on the
    // row PostgreSQL actually holds.
    const secrets = Object.fromEntries(
      SENSITIVE_KEYS.map((key): [string, string] => [key, `SECRET-${key}-${RUN_TAG}`]),
    );
    expect(Object.keys(secrets)).toEqual([...SENSITIVE_KEYS]);
    // ADR-053 § 5 names the sealed-bid fields by hand.
    for (const key of ['bidAmount', 'bidContent', 'quotationAmount', 'sealedPayload']) {
      expect(secrets[key]).toBe(`SECRET-${key}-${RUN_TAG}`);
    }

    const source = envelope({
      eventName: 'A_NAME_NO_SERVICE_HAS_DECLARED',
      payload: { ...secrets, note: 'ordinary' },
    });

    expect(
      await repository.ingest(
        toAuditEventRecord(source, delivery('rasta.supplier.v1')),
        DOMAIN_PROJECTOR_CONSUMER,
      ),
    ).toBe('WRITTEN');

    const row = await prisma.client.auditEvent.findFirstOrThrow({
      where: { sourceEventId: source.eventId },
    });

    // Kept, under its own name.
    expect(row.sourceEventName).toBe('A_NAME_NO_SERVICE_HAS_DECLARED');
    expect(row.action).toBe('A_NAME_NO_SERVICE_HAS_DECLARED');
    // And no payload anywhere in it. `changes` stays null until path B.
    expect(row.changes).toBeNull();

    const asText = JSON.stringify(row, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const secret of Object.values(secrets)) {
      expect(asText).not.toContain(secret);
    }
    expect(asText).not.toContain('SECRET-');
  });

  describe('the AUD-003 hash chain', () => {
    /**
     * The chain the writer builds, read back from the columns PostgreSQL holds
     * and recomputed with the production functions.
     *
     * Recomputed rather than compared against a literal: a fixture digest would
     * only prove that this test and `computeRecordHash` agree today, whereas
     * re-deriving the value from the stored row proves the row carries
     * everything the hash covers — which is the claim ADR-053 § 6 makes and the
     * only one an operator holding a database dump could ever check.
     */
    it('opens a chain with the first record and links the second to it', async () => {
      // The same tenant and the same UTC month, so both records land in one
      // chain. `envelope()` mints a fresh tenant each call, which would
      // otherwise give each record a chain of its own.
      const tenantId = id('ORG');
      const firstSource = envelope({ tenantId, occurredAt: '2026-11-20T14:05:00.000Z' });
      const secondSource = envelope({ tenantId, occurredAt: '2026-11-21T09:30:00.000Z' });

      expect(
        await repository.ingest(
          toAuditEventRecord(firstSource, delivery()),
          DOMAIN_PROJECTOR_CONSUMER,
        ),
      ).toBe('WRITTEN');
      expect(
        await repository.ingest(
          toAuditEventRecord(secondSource, delivery()),
          DOMAIN_PROJECTOR_CONSUMER,
        ),
      ).toBe('WRITTEN');

      const first = await prisma.client.auditEvent.findFirstOrThrow({
        where: { sourceEventId: firstSource.eventId },
      });
      const second = await prisma.client.auditEvent.findFirstOrThrow({
        where: { sourceEventId: secondSource.eventId },
      });

      // The first link of a chain: a full SHA-256, and nothing before it.
      expect(first.recordHash).not.toBeNull();
      expect(first.recordHash?.length).toBe(CHAIN_HASH_BYTES);
      expect(first.previousHash).toBeNull();
      expect(first.correctionOf).toBeNull();

      // The second points at the first, and at nothing else.
      expect(second.previousHash).not.toBeNull();
      expect(hashesEqual(second.previousHash, first.recordHash)).toBe(true);
      expect(second.sequenceNo).toBeGreaterThan(first.sequenceNo);

      // Both digests reproduce from the stored row.
      expect(hashesEqual(computeRecordHash(first, null), first.recordHash)).toBe(true);
      expect(hashesEqual(computeRecordHash(second, first.recordHash), second.recordHash)).toBe(
        true,
      );

      // And the head names the tail, with the segment opened at the head record.
      const head = await headOf(tenantId, '2026-11-01');
      expect(head.chain_length).toBe(2n);
      expect(hashesEqual(head.head_hash, second.recordHash)).toBe(true);
      expect(head.head_event_id).toBe(second.id);
      expect(head.head_sequence_no).toBe(second.sequenceNo);
      expect(head.first_sequence_no).toBe(first.sequenceNo);
    });

    it('gives a different UTC month of the same tenant its own chain', async () => {
      // ADR-053 § 6 scopes a chain to `(organization, UTC month)`. A record in
      // a new month opens a new segment rather than continuing the old one,
      // which is what keeps two months independently writable.
      const tenantId = id('ORG');
      const november = envelope({ tenantId, occurredAt: '2026-11-02T00:00:00.000Z' });
      const december = envelope({ tenantId, occurredAt: '2026-12-02T00:00:00.000Z' });

      await repository.ingest(toAuditEventRecord(november, delivery()), DOMAIN_PROJECTOR_CONSUMER);
      await repository.ingest(toAuditEventRecord(december, delivery()), DOMAIN_PROJECTOR_CONSUMER);

      const decemberRow = await prisma.client.auditEvent.findFirstOrThrow({
        where: { sourceEventId: december.eventId },
      });
      expect(decemberRow.previousHash).toBeNull();

      expect((await headOf(tenantId, '2026-11-01')).chain_length).toBe(1n);
      expect((await headOf(tenantId, '2026-12-01')).chain_length).toBe(1n);
    });

    it('leaves the head untouched when a redelivery is refused', async () => {
      // A chain that grew on redelivery would report a length no set of records
      // could reproduce. The duplicate check runs before the chain is touched,
      // so the tip must be byte-for-byte what it was.
      const tenantId = id('ORG');
      const source = envelope({ tenantId });

      expect(
        await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER),
      ).toBe('WRITTEN');
      const before = await headOf(tenantId, '2026-11-01');

      expect(
        await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER),
      ).toBe('DUPLICATE');
      const after = await headOf(tenantId, '2026-11-01');

      expect(after.chain_length).toBe(before.chain_length);
      expect(after.head_event_id).toBe(before.head_event_id);
      expect(after.head_sequence_no).toBe(before.head_sequence_no);
      expect(after.first_sequence_no).toBe(before.first_sequence_no);
      expect(hashesEqual(after.head_hash, before.head_hash)).toBe(true);

      expect(
        await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } }),
      ).toBe(1);
    });

    it('rolls the chain back with the record when the transaction fails', async () => {
      // The strongest statement this suite can make about the write path: a
      // failure *after* the head has been advanced inside the transaction must
      // leave no row, no marker and no advancement. Forced with a projection
      // the database refuses — `organization_ref_parent_not_self` — which
      // `applyOrganizationProjection` runs last, so everything before it is
      // already written when the statement raises.
      const tenantId = id('ORG');
      const anchor = envelope({ tenantId });
      await repository.ingest(toAuditEventRecord(anchor, delivery()), DOMAIN_PROJECTOR_CONSUMER);
      const before = await headOf(tenantId, '2026-11-01');

      const doomed = envelope({ tenantId });
      const selfParented: OrganizationProjection = {
        kind: 'CREATED',
        organizationId: tenantId,
        parentOrganizationId: tenantId,
        hierarchyPath: null,
        hierarchyDepth: 0,
        status: 'ACTIVE',
        observedAt: new Date(),
      };

      await expect(
        repository.ingest(
          toAuditEventRecord(doomed, delivery()),
          DOMAIN_PROJECTOR_CONSUMER,
          selfParented,
        ),
      ).rejects.toThrow();

      expect(
        await prisma.client.auditEvent.count({ where: { sourceEventId: doomed.eventId } }),
      ).toBe(0);
      expect(await prisma.client.processedEvent.count({ where: { eventId: doomed.eventId } })).toBe(
        0,
      );

      const after = await headOf(tenantId, '2026-11-01');
      expect(after.chain_length).toBe(before.chain_length);
      expect(after.head_event_id).toBe(before.head_event_id);
      expect(after.head_sequence_no).toBe(before.head_sequence_no);
      expect(hashesEqual(after.head_hash, before.head_hash)).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('writes exactly one row for a redelivered event', async () => {
      const source = envelope();

      const first = await repository.ingest(
        toAuditEventRecord(source, delivery()),
        DOMAIN_PROJECTOR_CONSUMER,
      );
      // A *fresh* record for the same envelope — a new audit id, as a real
      // redelivery would produce. Only the source event id repeats.
      const second = await repository.ingest(
        toAuditEventRecord(source, delivery()),
        DOMAIN_PROJECTOR_CONSUMER,
      );

      expect(first).toBe('WRITTEN');
      expect(second).toBe('DUPLICATE');

      const rows = await prisma.client.auditEvent.count({
        where: { sourceEventId: source.eventId },
      });
      expect(rows).toBe(1);
    });

    it('records the processed marker exactly once', async () => {
      const source = envelope();
      await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER);
      await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER);

      const markers = await prisma.client.processedEvent.count({
        where: { eventId: source.eventId, consumerName: DOMAIN_PROJECTOR_CONSUMER },
      });
      expect(markers).toBe(1);
    });

    it('treats the same event on a different topic as a separate record', async () => {
      // ADR § 8's uniqueness key includes the topic, because a path-A row and a
      // path-B row for one action are two pieces of evidence, not a duplicate.
      // The consumer marker still makes the *second delivery to this consumer*
      // a no-op, which is what this asserts: the guard is the consumer, not the
      // index.
      const source = envelope();
      expect(
        await repository.ingest(toAuditEventRecord(source, delivery('rasta.asset.v1')), 'group-a'),
      ).toBe('WRITTEN');
      expect(
        await repository.ingest(
          toAuditEventRecord(source, delivery('rasta.asset.v1.retry')),
          'group-b',
        ),
      ).toBe('WRITTEN');

      const rows = await prisma.client.auditEvent.count({
        where: { sourceEventId: source.eventId },
      });
      expect(rows).toBe(2);
    });
  });

  it('writes the audit row and its marker atomically', async () => {
    // A row without its marker would be re-ingested; a marker without its row
    // is evidence lost with no trace. Forced here by making the marker insert
    // collide, which must roll the audit row back with it.
    const source = envelope();

    await prisma.client.processedEvent.create({
      data: { eventId: source.eventId, consumerName: 'atomicity-probe' },
    });

    const record = toAuditEventRecord(source, delivery());
    // The pre-existing marker makes this a DUPLICATE, so no row is written.
    expect(await repository.ingest(record, 'atomicity-probe')).toBe('DUPLICATE');

    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } })).toBe(
      0,
    );
  });

  it('projects the organization without reading another service database', async () => {
    const source = envelope();
    const { tenantId } = source;
    // Narrowed rather than asserted: `tenantId` is optional on the envelope,
    // and a factory change that dropped it would otherwise turn this test into
    // a lookup for `undefined` that quietly stopped proving anything.
    if (tenantId === undefined) throw new Error('this test needs a tenant-scoped envelope');

    await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER);

    const ref = await prisma.client.organizationRef.findUnique({
      where: { organizationId: tenantId },
    });
    expect(ref).not.toBeNull();
  });

  it('accepts a platform-scoped event and gives it the platform chain', async () => {
    // Deliberately in a month this run owns outright. The platform chain's key
    // is `('PLATFORM', '', month)` and carries nothing tag-shaped, so a fixed
    // month would be shared with every other run that ever wrote a
    // platform-scoped row — and `cleanupRun` would then have to choose between
    // deleting a head those rows still depend on and refusing to clean.
    const chainMonth = runMonth(0);
    const source = envelope({
      tenantId: undefined,
      occurredAt: instantIn(chainMonth, 5).toISOString(),
    });
    expect(
      await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER),
    ).toBe('WRITTEN');

    const row = await prisma.client.auditEvent.findFirstOrThrow({
      where: { sourceEventId: source.eventId },
    });
    expect(row.organizationId).toBeNull();

    // Its own chain, never a tenant's: the platform head is the only one keyed
    // by the empty organization.
    const head = await headOf(null, chainMonth);
    expect(head.chain_length).toBe(1n);
    expect(head.head_event_id).toBe(row.id);
    expect(hashesEqual(head.head_hash, row.recordHash)).toBe(true);
    expect(head.first_sequence_no).toBe(row.sequenceNo);
  });

  describe('partition routing', () => {
    async function partitionOf(sourceEventId: string): Promise<string> {
      const rows = await prisma.client.$queryRawUnsafe<{ partition: string }[]>(
        `SELECT tableoid::regclass::text AS partition FROM audit_event WHERE source_event_id = $1`,
        sourceEventId,
      );
      // `regclass` renders unqualified when the schema is on search_path.
      return (rows[0]?.partition ?? '').replace(/^audit\./, '');
    }

    it('routes a row to the month of its occurred_at', async () => {
      const source = envelope({ occurredAt: '2027-03-14T00:00:00.000Z' });
      await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER);

      expect(await partitionOf(source.eventId)).toBe('audit_event_2027_03');
    });

    it('routes an out-of-range date to DEFAULT rather than refusing it', async () => {
      // ADR § 11. An audit store that dropped evidence because of a date would
      // fail exactly when a clock is wrong — which is when evidence matters.
      const source = envelope({ occurredAt: '2019-01-01T00:00:00.000Z' });
      expect(
        await repository.ingest(toAuditEventRecord(source, delivery()), DOMAIN_PROJECTOR_CONSUMER),
      ).toBe('WRITTEN');

      expect(await partitionOf(source.eventId)).toBe('audit_event_default');
    });

    it('reports per-partition counts for the capacity gauge', async () => {
      const counts = await repository.partitionRowCounts();

      // Nineteen partitions exist whether or not they hold rows.
      expect(counts).toHaveLength(19);
      expect(counts.map((c) => c.partition)).toEqual(
        expect.arrayContaining(['audit_event_2026_09', 'audit_event_default']),
      );
      for (const { rows } of counts) expect(rows).toBeGreaterThanOrEqual(0);
    });
  });
});
