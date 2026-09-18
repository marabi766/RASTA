import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  type EventEnvelope,
} from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import {
  AuditTrailConsumer,
  AuditTrailPersistenceError,
} from '../src/consumers/audit-trail.consumer';
import {
  AUDIT_TRAIL_CONSUMER,
  AuditTrailRejectedError,
  toAuditTrailRecord,
} from '../src/audit/audit-trail.mapper';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
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
 * Path B against real PostgreSQL (AUD-004 Phase B).
 *
 * The consumer's `handle()` is driven directly, with the real repository, so
 * every claim below is about what the database holds — the columns, the chain,
 * the idempotency marker and the transaction boundary — without a broker in the
 * way. The broker half is `kafka-projector.int-spec.ts`.
 */
describe('audit-trail ingestion (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let trail: AuditTrailConsumer;

  const TRAIL: EventDelivery = Object.freeze({ topic: AUDIT_TRAIL_TOPIC, partition: 0 });

  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;

  interface MessageOptions {
    tenant?: string | null;
    occurredAt?: string;
    eventId?: string;
    payload?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
  }

  /**
   * One trail message. Tenant-scoped by default, with the tenant stated in both
   * places the contract requires; `tenant: null` omits it from both.
   */
  function message(options: MessageOptions = {}): EventEnvelope {
    const tenant = options.tenant === undefined ? id('ORG') : options.tenant;
    return {
      eventId: options.eventId ?? id('EVT'),
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: AUDIT_EVENT_RECORDED_VERSION,
      occurredAt: options.occurredAt ?? '2026-11-20T14:05:00.000Z',
      producer: 'identity-service',
      producerVersion: '1.3.0',
      aggregateType: 'AuditEvent',
      aggregateId: id('RES'),
      ...(tenant === null ? {} : { tenantId: tenant }),
      correlationId: id('COR'),
      payload: {
        actor: { type: 'USER', id: id('USR'), roles: ['UNION_ADMIN'] },
        ...(tenant === null ? {} : { organizationId: tenant }),
        action: 'audit.access.refuse',
        resourceType: 'AuditEvent',
        resourceId: id('RES'),
        outcome: 'REFUSED',
        errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
        occurrenceCount: 1,
        ...options.payload,
      },
      ...options.envelope,
    } as EventEnvelope;
  }

  const rowOf = (sourceEventId: string, topic: string = AUDIT_TRAIL_TOPIC) =>
    prisma.client.auditEvent.findFirstOrThrow({ where: { sourceEventId, sourceTopic: topic } });

  const markersOf = (eventId: string, consumerName: string = AUDIT_TRAIL_CONSUMER) =>
    prisma.client.processedEvent.count({ where: { eventId, consumerName } });

  /** One chain head, as the row the database holds, or `null`. */
  interface ChainHeadRow {
    chain_length: bigint;
    head_hash: Uint8Array | null;
    head_event_id: string | null;
    head_sequence_no: bigint | null;
  }

  async function headOf(
    organizationId: string | null,
    chainMonth: string,
  ): Promise<ChainHeadRow | null> {
    const rows = await prisma.client.$queryRawUnsafe<ChainHeadRow[]>(
      `SELECT chain_length, head_hash, head_event_id, head_sequence_no
         FROM audit_chain_head
        WHERE chain_scope = $1::audit_chain_scope
          AND organization_id = $2
          AND chain_month = $3::date`,
      organizationId === null ? 'PLATFORM' : 'ORGANIZATION',
      organizationId ?? '',
      chainMonth,
    );
    return rows[0] ?? null;
  }

  /** A row flattened to comparable text — bigints and bytes included. */
  const snapshot = (row: unknown): string =>
    JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint'
        ? `bigint:${value.toString()}`
        : value instanceof Uint8Array
          ? `bytes:${Buffer.from(value).toString('hex')}`
          : value,
    );

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    repository = new AuditRepository(prisma);
    trail = new AuditTrailConsumer(() => ({}) as EventConsumer, repository, silentLogger);
  }, 60_000);

  afterAll(async () => {
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 60_000);

  it('persists every path-B column, and the stored row reproduces its own hash', async () => {
    const tenant = id('ORG');
    const changes = [
      { field: 'status', from: 'ACTIVE', to: 'SUSPENDED' },
      { field: 'seatCount', from: 3, to: 4.5 },
      { field: 'mfaRequired', from: false, to: true },
      { field: 'suspendedAt', from: null, to: '2026-11-20T14:05:00.000Z' },
      { field: 'password', from: { redacted: true }, to: { redacted: true } },
      { field: 'nationalId', from: { hash: 'sha256:aa11' }, to: { hash: 'sha256:bb22' } },
    ];
    const source = message({
      tenant,
      envelope: {
        causationId: id('CAU'),
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        streamSeq: 5,
      },
      payload: {
        actor: { type: 'USER', id: 'USR-trail-actor', roles: ['UNION_ADMIN', 'FLEET_MANAGER'] },
        resourceType: 'Organization',
        resourceId: `RES_${RUN_TAG}_trail`,
        outcome: 'FAILURE',
        errorCode: ERROR_CODES.FORBIDDEN,
        reason: 'Suspension requested outside the approval window',
        changes,
        occurrenceCount: 7,
        source: { ip: '2001:db8::7', userAgent: 'Mozilla/5.0 (Rasta itest)' },
      },
    });

    await trail.handle(source, TRAIL);

    const row = await rowOf(source.eventId);
    expect(row).toMatchObject({
      occurredAt: new Date('2026-11-20T14:05:00.000Z'),
      actorType: 'USER',
      actorId: 'USR-trail-actor',
      actorRoles: ['UNION_ADMIN', 'FLEET_MANAGER'],
      organizationId: tenant,
      action: 'audit.access.refuse',
      resourceType: 'Organization',
      resourceId: `RES_${RUN_TAG}_trail`,
      outcome: 'FAILURE',
      errorCode: 'FORBIDDEN',
      reason: 'Suspension requested outside the approval window',
      changes,
      occurrenceCount: 7,
      sourceService: 'identity-service',
      sourceServiceVersion: '1.3.0',
      sourceEventId: source.eventId,
      sourceEventName: AUDIT_EVENT_RECORDED,
      sourceTopic: AUDIT_TRAIL_TOPIC,
      sourceIp: '2001:db8::7',
      sourceUserAgent: 'Mozilla/5.0 (Rasta itest)',
      correlationId: source.correlationId,
      causationId: source.causationId,
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      sourceStreamSeq: 5n,
      correctionOf: null,
    });
    expect(row.id).not.toBe(source.eventId);

    // Covered by the chain: the digest recomputes from exactly what PostgreSQL
    // returned, including the delta after its JSONB round trip.
    expect(row.recordHash?.length).toBe(CHAIN_HASH_BYTES);
    expect(row.previousHash).toBeNull();
    expect(hashesEqual(computeRecordHash(row, null), row.recordHash)).toBe(true);

    expect(await markersOf(source.eventId)).toBe(1);
    expect(await markersOf(source.eventId, DOMAIN_PROJECTOR_CONSUMER)).toBe(0);
    expect(await prisma.client.organizationRef.count({ where: { organizationId: tenant } })).toBe(
      1,
    );
  });

  it('records a correction as a new linked row and leaves the original untouched', async () => {
    const tenant = id('ORG');
    const original = message({ tenant, occurredAt: '2026-11-21T09:00:00.000Z' });
    await trail.handle(original, TRAIL);
    const before = await rowOf(original.eventId);
    const originalSnapshot = snapshot(before);

    const correction = message({
      tenant,
      occurredAt: '2026-11-21T09:30:00.000Z',
      payload: {
        action: 'audit.correction',
        outcome: 'SUCCESS',
        errorCode: undefined,
        reason: 'Refusal was recorded against the wrong resource (SEC-114)',
        resourceId: before.id,
        correctionOf: before.id,
      },
    });
    await trail.handle(correction, TRAIL);

    const corrected = await rowOf(correction.eventId);
    expect(corrected.id).not.toBe(before.id);
    expect(corrected.correctionOf).toBe(before.id);
    expect(corrected.action).toBe('audit.correction');
    expect(corrected.outcome).toBe('SUCCESS');
    expect(corrected.reason).toBe('Refusal was recorded against the wrong resource (SEC-114)');

    // Append-only: the original is byte-for-byte what it was, hash included.
    expect(snapshot(await rowOf(original.eventId))).toBe(originalSnapshot);
    expect(await prisma.client.auditEvent.count({ where: { organizationId: tenant } })).toBe(2);

    // And the correction is the next link in the same chain, not a rewrite of
    // the old one.
    expect(hashesEqual(corrected.previousHash, before.recordHash)).toBe(true);
    expect(hashesEqual(computeRecordHash(corrected, before.recordHash), corrected.recordHash)).toBe(
      true,
    );
    const head = await headOf(tenant, '2026-11-01');
    expect(head?.chain_length).toBe(2n);
    expect(head?.head_event_id).toBe(corrected.id);
  });

  it('gives a tenant record its tenant chain and a platform record the platform chain', async () => {
    const tenant = id('ORG');
    const tenantMessage = message({ tenant });
    await trail.handle(tenantMessage, TRAIL);

    // A month this run owns outright: the platform chain's key carries nothing
    // tag-shaped (see `runMonth`).
    const chainMonth = runMonth(1);
    const platformMessage = message({
      tenant: null,
      occurredAt: instantIn(chainMonth, 11).toISOString(),
      payload: { actor: { type: 'SYSTEM', id: 'identity-service', roles: [] } },
    });
    await trail.handle(platformMessage, TRAIL);

    const tenantRow = await rowOf(tenantMessage.eventId);
    const platformRow = await rowOf(platformMessage.eventId);

    expect(tenantRow.organizationId).toBe(tenant);
    expect(platformRow.organizationId).toBeNull();

    const tenantHead = await headOf(tenant, '2026-11-01');
    expect(tenantHead?.chain_length).toBe(1n);
    expect(tenantHead?.head_event_id).toBe(tenantRow.id);

    const platformHead = await headOf(null, chainMonth);
    expect(platformHead?.chain_length).toBe(1n);
    expect(platformHead?.head_event_id).toBe(platformRow.id);
    expect(hashesEqual(platformHead?.head_hash ?? null, platformRow.recordHash)).toBe(true);

    // Neither record reached the other's chain.
    expect(await headOf(tenant, chainMonth)).toBeNull();
  });

  it('writes one row, one marker and one chain advance for a redelivered message', async () => {
    const tenant = id('ORG');
    const source = message({ tenant });

    await trail.handle(source, TRAIL);
    const afterFirst = await headOf(tenant, '2026-11-01');

    // Exactly as an at-least-once redelivery arrives: the same bytes again.
    await trail.handle(source, TRAIL);
    const afterSecond = await headOf(tenant, '2026-11-01');

    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } })).toBe(
      1,
    );
    expect(await markersOf(source.eventId)).toBe(1);
    expect(afterFirst?.chain_length).toBe(1n);
    expect(afterSecond?.chain_length).toBe(1n);
    expect(afterSecond?.head_event_id).toBe(afterFirst?.head_event_id);
    expect(hashesEqual(afterSecond?.head_hash ?? null, afterFirst?.head_hash ?? null)).toBe(true);
  });

  it('advances the chain once when two deliveries of one message race', async () => {
    // Both transactions can pass the marker check before either commits; the
    // chain lock serialises them and the source-identity index refuses the
    // second row, which the repository reports as a duplicate.
    const tenant = id('ORG');
    const source = message({ tenant });

    await Promise.all([trail.handle(source, TRAIL), trail.handle(source, TRAIL)]);

    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } })).toBe(
      1,
    );
    expect(await markersOf(source.eventId)).toBe(1);
    expect((await headOf(tenant, '2026-11-01'))?.chain_length).toBe(1n);
  });

  it('is not suppressed by a path-A record of the same event id', async () => {
    // The two paths' idempotency namespaces are the consumer names. A domain
    // producer's event id already marked by the projector must not make the
    // trail consumer believe it has recorded its own message.
    const tenant = id('ORG');
    const sharedEventId = id('EVT');

    const domainEnvelope = {
      eventId: sharedEventId,
      eventName: 'USER_ROLE_ASSIGNED',
      eventVersion: 1,
      occurredAt: '2026-11-22T08:00:00.000Z',
      producer: 'identity-service',
      aggregateType: 'User',
      aggregateId: id('USR'),
      tenantId: tenant,
      correlationId: id('COR'),
      payload: {},
    } as unknown as EventEnvelope;
    expect(
      await repository.ingest(
        toAuditEventRecord(
          domainEnvelope,
          Object.freeze({ topic: 'rasta.identity.v1', partition: 0 }),
        ),
        DOMAIN_PROJECTOR_CONSUMER,
      ),
    ).toBe('WRITTEN');
    expect(await markersOf(sharedEventId, DOMAIN_PROJECTOR_CONSUMER)).toBe(1);

    await trail.handle(
      message({ tenant, eventId: sharedEventId, occurredAt: '2026-11-22T08:00:01.000Z' }),
      TRAIL,
    );

    const trailRow = await rowOf(sharedEventId);
    expect(trailRow.sourceEventName).toBe(AUDIT_EVENT_RECORDED);
    expect(await rowOf(sharedEventId, 'rasta.identity.v1')).toBeDefined();
    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: sharedEventId } })).toBe(
      2,
    );
    expect(await markersOf(sharedEventId)).toBe(1);
    expect(await markersOf(sharedEventId, DOMAIN_PROJECTOR_CONSUMER)).toBe(1);
  });

  it('touches nothing for a tenant-mismatched message', async () => {
    const tenant = id('ORG');
    const other = id('ORG');
    const source = message({ tenant, payload: { organizationId: other } });

    await expect(trail.handle(source, TRAIL)).rejects.toThrow(AuditTrailRejectedError);

    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } })).toBe(
      0,
    );
    expect(await prisma.client.processedEvent.count({ where: { eventId: source.eventId } })).toBe(
      0,
    );
    expect(await headOf(tenant, '2026-11-01')).toBeNull();
    expect(await headOf(other, '2026-11-01')).toBeNull();
  });

  describe('a failed transaction leaves neither evidence nor marker', () => {
    it('when the evidence insert itself is refused', async () => {
      // PostgreSQL refuses a NUL byte in text. The contract does not, so this
      // is a message that passes every check this service makes and still
      // fails inside the transaction — after the chain head was opened and
      // locked, so a rollback that missed anything would show in the head.
      const tenant = id('ORG');
      const anchor = message({ tenant });
      await trail.handle(anchor, TRAIL);
      const before = await headOf(tenant, '2026-11-01');

      const doomed = message({
        tenant,
        // Built rather than written as an escape, so the source file itself
        // never carries a NUL byte.
        payload: { reason: `SENTINEL-${RUN_TAG}${String.fromCharCode(0)}-reason` },
      });
      const failure = await trail.handle(doomed, TRAIL).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AuditTrailPersistenceError);
      expect((failure as Error).message).not.toContain('SENTINEL');

      expect(
        await prisma.client.auditEvent.count({ where: { sourceEventId: doomed.eventId } }),
      ).toBe(0);
      expect(await prisma.client.processedEvent.count({ where: { eventId: doomed.eventId } })).toBe(
        0,
      );
      const after = await headOf(tenant, '2026-11-01');
      expect(after?.chain_length).toBe(before?.chain_length);
      expect(after?.head_event_id).toBe(before?.head_event_id);
      expect(hashesEqual(after?.head_hash ?? null, before?.head_hash ?? null)).toBe(true);
    });

    it('when the marker insert fails after the evidence was written', async () => {
      // The other direction: the row and the head update have both succeeded
      // inside the transaction when the marker insert is refused (its consumer
      // name exceeds `VARCHAR(128)`). All of it must roll back together.
      const tenant = id('ORG');
      const anchor = message({ tenant });
      await trail.handle(anchor, TRAIL);
      const before = await headOf(tenant, '2026-11-01');

      const doomed = message({ tenant });
      await expect(
        repository.ingest(toAuditTrailRecord(doomed, TRAIL), 'x'.repeat(200)),
      ).rejects.toThrow();

      expect(
        await prisma.client.auditEvent.count({ where: { sourceEventId: doomed.eventId } }),
      ).toBe(0);
      expect(await prisma.client.processedEvent.count({ where: { eventId: doomed.eventId } })).toBe(
        0,
      );
      const after = await headOf(tenant, '2026-11-01');
      expect(after?.chain_length).toBe(before?.chain_length);
      expect(after?.head_event_id).toBe(before?.head_event_id);
    });
  });
});
