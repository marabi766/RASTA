import request from 'supertest';
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
import { AuditTrailConsumer } from '../src/consumers/audit-trail.consumer';
import { computeRecordHash, hashesEqual } from '../src/audit/audit.chain';
import { internalToken, startApi, systemAdmin, unionAdmin, type ApiHarness } from './api-helpers';
import { cleanupRun, id, instantIn, newMigratorPrisma, newPrisma, runMonth } from './helpers';

/**
 * Correction linkage and the internal target lookup, against a real PostgreSQL
 * (ADR-053 § 7, AUD-003 correction).
 *
 * Records enter exactly as production writes them — through the real path-B
 * consumer — and are read back through the real read API and the real internal
 * lookup. Nothing here updates or deletes an evidence row; the database refuses
 * both, and the assertions below prove the original is byte-for-byte unchanged.
 *
 * Everything written carries this run's tag; `cleanupRun` removes exactly that.
 */

const TRAIL: EventDelivery = Object.freeze({ topic: AUDIT_TRAIL_TOPIC, partition: 0 });

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

/** A snapshot comparable across reads — bigints and bytes included. */
const snapshot = (row: unknown): string =>
  JSON.stringify(row, (_key, value: unknown) =>
    typeof value === 'bigint'
      ? `bigint:${value.toString()}`
      : value instanceof Uint8Array
        ? `bytes:${Buffer.from(value).toString('hex')}`
        : value,
  );

describe('correction linkage and the internal target lookup (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let trail: AuditTrailConsumer;
  let api: ApiHarness;

  const original = (tenant: string | null, occurredAt: string): EventEnvelope =>
    ({
      eventId: id('EVT'),
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: AUDIT_EVENT_RECORDED_VERSION,
      occurredAt,
      producer: 'identity-service',
      producerVersion: '0.1.0',
      aggregateType: 'AuditEvent',
      aggregateId: id('RES'),
      ...(tenant === null ? {} : { tenantId: tenant }),
      correlationId: id('COR'),
      payload: {
        actor: { type: 'USER', id: id('USR'), roles: ['FLEET_MANAGER'] },
        ...(tenant === null ? {} : { organizationId: tenant }),
        action: 'identity.users.list',
        resourceType: 'User',
        resourceId: id('RES'),
        outcome: 'REFUSED',
        errorCode: ERROR_CODES.INSUFFICIENT_ROLE,
        occurrenceCount: 1,
      },
    }) as EventEnvelope;

  /** A correction shaped exactly as identity-service's command produces one. */
  const correction = (
    tenant: string | null,
    targetId: string,
    occurredAt: string,
    streamSeq = 1,
  ): EventEnvelope =>
    ({
      eventId: id('EVT'),
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: AUDIT_EVENT_RECORDED_VERSION,
      occurredAt,
      producer: 'identity-service',
      producerVersion: '0.1.0',
      aggregateType: 'AuditEvent',
      aggregateId: targetId,
      ...(tenant === null ? {} : { tenantId: tenant }),
      correlationId: id('COR'),
      actor: { type: 'USER', id: id('USRADMIN') },
      streamKey: targetId,
      streamSeq,
      payload: {
        actor: { type: 'USER', id: id('USRADMIN'), roles: ['SYSTEM_ADMIN'] },
        ...(tenant === null ? {} : { organizationId: tenant }),
        action: 'audit.correction',
        resourceType: 'AuditEvent',
        resourceId: targetId,
        outcome: 'SUCCESS',
        reason: 'Recorded against the wrong role list (INC-5120)',
        changes: [
          { field: 'outcome', from: 'REFUSED', to: 'SUCCESS' },
          { field: 'credentials.password', from: { redacted: true }, to: { redacted: true } },
        ],
        occurrenceCount: 1,
        correctionOf: targetId,
      },
    }) as EventEnvelope;

  const rowOf = (sourceEventId: string) =>
    prisma.client.auditEvent.findFirstOrThrow({
      where: { sourceEventId, sourceTopic: AUDIT_TRAIL_TOPIC },
    });

  const window = (at: string) => ({
    from: new Date(Date.parse(at) - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(Date.parse(at) + 24 * 60 * 60 * 1000).toISOString(),
  });

  const read = (token: string, recordId: string, at: string, organizationId?: string) =>
    request(api.app.getHttpServer())
      .get(`/v1/audit-events/${recordId}`)
      .query({ ...window(at), ...(organizationId ? { organizationId } : {}) })
      .set('authorization', `Bearer ${token}`);

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    repository = new AuditRepository(prisma);
    trail = new AuditTrailConsumer(() => ({}) as EventConsumer, repository, silentLogger);
    api = await startApi();
  }, 60_000);

  afterAll(async () => {
    await api?.close();
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 120_000);

  it('links a tenant correction both ways, leaves the original untouched, and extends the same chain', async () => {
    const tenant = id('ORG');
    const source = original(tenant, '2026-11-24T08:00:00.000Z');
    await trail.handle(source, TRAIL);
    const before = await rowOf(source.eventId);
    const originalSnapshot = snapshot(before);

    const fix = correction(tenant, before.id, '2026-11-24T08:30:00.000Z');
    await trail.handle(fix, TRAIL);
    const corrected = await rowOf(fix.eventId);

    // Append-only: a new row, and the original byte-for-byte as it was.
    expect(corrected.id).not.toBe(before.id);
    expect(corrected.correctionOf).toBe(before.id);
    expect(snapshot(await rowOf(source.eventId))).toBe(originalSnapshot);
    // The next link in the same tenant-month chain.
    expect(corrected.organizationId).toBe(tenant);
    expect(hashesEqual(corrected.previousHash, before.recordHash)).toBe(true);
    expect(hashesEqual(computeRecordHash(corrected, before.recordHash), corrected.recordHash)).toBe(
      true,
    );
    expect(corrected.sequenceNo > before.sequenceNo).toBe(true);

    // Read side, as the platform: both directions.
    const originalView = await read(systemAdmin(), before.id, source.occurredAt);
    expect(originalView.status).toBe(200);
    expect(originalView.body).toMatchObject({ correctionOf: null, correctedBy: [corrected.id] });
    const correctionView = await read(systemAdmin(), corrected.id, fix.occurredAt);
    expect(correctionView.body).toMatchObject({ correctionOf: before.id, correctedBy: [] });
    // Sensitive values arrived redacted and stay that way.
    expect(JSON.stringify(correctionView.body)).not.toMatch(/"credentials\.password","from":"/);

    // As the tenant's own union administrator: the same links.
    const asUnion = await read(unionAdmin(tenant), before.id, source.occurredAt);
    expect(asUnion.status).toBe(200);
    expect(asUnion.body.correctedBy).toEqual([corrected.id]);

    // A search returns both, each with its link.
    const page = await request(api.app.getHttpServer())
      .get('/v1/audit-events')
      .query({ ...window(source.occurredAt), organizationId: tenant })
      .set('authorization', `Bearer ${systemAdmin()}`);
    expect(page.status).toBe(200);
    const byId = new Map<string, { correctionOf: string | null; correctedBy: string[] }>(
      page.body.items.map(
        (item: { id: string; correctionOf: string | null; correctedBy: string[] }) => [
          item.id,
          item,
        ],
      ),
    );
    expect(byId.get(before.id)).toMatchObject({ correctionOf: null, correctedBy: [corrected.id] });
    expect(byId.get(corrected.id)).toMatchObject({ correctionOf: before.id, correctedBy: [] });

    // And the range still verifies: a correction is a link, not a rewrite.
    const verification = await request(api.app.getHttpServer())
      .get('/v1/audit-events/verify')
      .query({ ...window(source.occurredAt), organizationId: tenant })
      .set('authorization', `Bearer ${systemAdmin()}`);
    expect(verification.status).toBe(200);
    expect(verification.body.status).toBe('VALID');
  });

  it('never leaks a link across tenants, in either direction', async () => {
    const tenantA = id('ORG');
    const tenantB = id('ORG');
    const source = original(tenantA, '2026-11-24T09:00:00.000Z');
    await trail.handle(source, TRAIL);
    const target = await rowOf(source.eventId);

    // A correction filed under another tenant that nonetheless names A's record
    // — path B does not check targets (the producer does), so the read side
    // must never let it surface under A's authority.
    const foreign = correction(tenantB, target.id, '2026-11-24T09:30:00.000Z');
    await trail.handle(foreign, TRAIL);
    const foreignRow = await rowOf(foreign.eventId);

    const asA = await read(unionAdmin(tenantA), target.id, source.occurredAt);
    expect(asA.status).toBe(200);
    expect(asA.body.correctedBy).toEqual([]);

    const asPlatformNarrowedToA = await read(systemAdmin(), target.id, source.occurredAt, tenantA);
    expect(asPlatformNarrowedToA.body.correctedBy).toEqual([]);

    // B's administrator cannot read A's original at all, nor learn it exists.
    expect((await read(unionAdmin(tenantB), target.id, source.occurredAt)).status).toBe(404);
    // B's own correction row is B's, and A cannot see it.
    expect((await read(unionAdmin(tenantA), foreignRow.id, foreign.occurredAt)).status).toBe(404);
  });

  it('links a platform-scoped correction in the platform chain, visible only to the platform', async () => {
    const chainMonth = runMonth(7);
    const at = instantIn(chainMonth, 30).toISOString();
    const later = instantIn(chainMonth, 45).toISOString();
    const source = original(null, at);
    await trail.handle(source, TRAIL);
    const before = await rowOf(source.eventId);

    const fix = correction(null, before.id, later);
    await trail.handle(fix, TRAIL);
    const corrected = await rowOf(fix.eventId);

    expect(corrected.organizationId).toBeNull();
    expect(corrected.correctionOf).toBe(before.id);
    expect(hashesEqual(corrected.previousHash, before.recordHash)).toBe(true);

    const view = await read(systemAdmin(), before.id, at);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ organizationId: null, correctedBy: [corrected.id] });

    // A tenant-scoped reader never sees a platform record or its link.
    expect((await read(unionAdmin(id('ORG')), before.id, at)).status).toBe(404);
  });

  describe('GET /v1/internal/audit-events/:id', () => {
    const lookup = (token: string, recordId: string, occurredAt: string) =>
      request(api.app.getHttpServer())
        .get(`/v1/internal/audit-events/${recordId}`)
        .query({ occurredAt })
        .set('x-internal-token', token);

    it('answers identity-service with exactly the id, organization and instant', async () => {
      const tenant = id('ORG');
      const source = original(tenant, '2026-11-24T10:00:00.000Z');
      await trail.handle(source, TRAIL);
      const row = await rowOf(source.eventId);

      const response = await lookup(
        await internalToken('identity-service'),
        row.id,
        source.occurredAt,
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: row.id,
        organizationId: tenant,
        occurredAt: source.occurredAt,
      });
    });

    it('names a platform-scoped record’s organization as null', async () => {
      const at = instantIn(runMonth(7), 50).toISOString();
      const source = original(null, at);
      await trail.handle(source, TRAIL);
      const row = await rowOf(source.eventId);

      const response = await lookup(await internalToken('identity-service'), row.id, at);

      expect(response.status).toBe(200);
      expect(response.body.organizationId).toBeNull();
    });

    it('answers a wrong instant and an unknown id with the same 404', async () => {
      const source = original(id('ORG'), '2026-11-24T11:00:00.000Z');
      await trail.handle(source, TRAIL);
      const row = await rowOf(source.eventId);
      const token = await internalToken('identity-service');

      const wrongInstant = await lookup(token, row.id, '2026-11-24T11:00:00.001Z');
      const unknown = await lookup(token, id('NOPE').slice(0, 26), source.occurredAt);

      expect(wrongInstant.status).toBe(404);
      expect(unknown.status).toBe(404);
      // Indistinguishable: the same code and the same message. The platform
      // body's `path` echoes the caller's own request URL back, as on every
      // error, so it is excluded; the message itself names no identifier.
      expect(wrongInstant.body.code).toBe(unknown.body.code);
      expect(wrongInstant.body.message).toBe(unknown.body.message);
      expect(wrongInstant.body.message).not.toContain(row.id);
      expect(Object.keys(wrongInstant.body).sort()).toEqual(Object.keys(unknown.body).sort());
    });

    it('refuses every other service, every user and every anonymous caller', async () => {
      const source = original(id('ORG'), '2026-11-24T12:00:00.000Z');
      await trail.handle(source, TRAIL);
      const row = await rowOf(source.eventId);

      expect(
        (await lookup(await internalToken('economic-service'), row.id, source.occurredAt)).status,
      ).toBe(403);
      const asUser = await request(api.app.getHttpServer())
        .get(`/v1/internal/audit-events/${row.id}`)
        .query({ occurredAt: source.occurredAt })
        .set('authorization', `Bearer ${systemAdmin()}`);
      expect(asUser.status).toBe(403);
      const anonymous = await request(api.app.getHttpServer())
        .get(`/v1/internal/audit-events/${row.id}`)
        .query({ occurredAt: source.occurredAt });
      expect(anonymous.status).toBe(401);
    });

    it('requires the instant, and grants identity-service nothing on the general read API', async () => {
      const token = await internalToken('identity-service');
      const missing = await request(api.app.getHttpServer())
        .get(`/v1/internal/audit-events/${id('X').slice(0, 26)}`)
        .set('x-internal-token', token);
      expect(missing.status).toBe(400);

      const general = await request(api.app.getHttpServer())
        .get('/v1/audit-events')
        .query(window('2026-11-24T12:00:00.000Z'))
        .set('x-internal-token', token);
      expect(general.status).toBe(403);
    });
  });
});
