import {
  Module,
  VersioningType,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { AllExceptionsFilter, RolesGuard, runWithContext } from '@rasta/nest-common';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { AvailabilityService } from '../src/fleet/availability.service';
import { FleetController } from '../src/fleet/fleet.controller';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { IdempotencyStore } from '../src/fleet/idempotency';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ENV } from '../src/tokens';
import { cleanup, id, newPrisma, producerShaped, tenants } from './helpers';

/**
 * Idempotency-Key on `POST /v1/fleet/availability`, and the read of a machine's
 * declarations (EXP-002 slice 7, docs/06 § 6.8) — against real PostgreSQL,
 * behind a real HTTP stack (the platform's role guard and exception filter, the
 * caller's context set by a middleware as the request context middleware does).
 *
 * Every claim is about what the database holds after the requests: how many
 * windows exist, which is live, how many events wait in the outbox, and what
 * each caller was answered. A declaration supersedes the machine's previous
 * one, so without the key a retried old request silently undoes a newer
 * declaration — the case `a retry of an old declaration` below pins.
 */
describe('declaring availability under an Idempotency-Key', () => {
  let prisma: PrismaService;
  let repository: FleetRepository;
  let http: INestApplication;

  const org = tenants();
  const caller = { userId: 'USR-ITEST-MANAGER' };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    await cleanup(prisma, [org.a, org.b]);

    const availability = new AvailabilityService(repository);
    const store = new IdempotencyStore(prisma, {
      FLEET_IDEMPOTENCY_TTL_HOURS: 24,
      FLEET_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120,
    });

    const withCaller = (
      req: { headers: Record<string, string | undefined> },
      _res: unknown,
      next: () => void,
    ) => {
      runWithContext(
        {
          correlationId: `itest-${ulid()}`,
          requestId: `itest-${ulid()}`,
          organizationId: req.headers['x-test-org'] ?? org.a,
          userId: req.headers['x-test-user'] ?? caller.userId,
          roles: (req.headers['x-test-roles'] ?? 'FLEET_MANAGER').split(','),
          organizationIds: [],
          authType: 'USER',
          startedAt: Date.now(),
        },
        () => next(),
      );
    };
    @Module({
      controllers: [FleetController],
      providers: [
        { provide: AvailabilityService, useValue: availability },
        { provide: IdempotencyStore, useValue: store },
        { provide: ENV, useValue: {} },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
    class HttpModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(withCaller).forRoutes('*');
      }
    }
    const moduleRef = await Test.createTestingModule({ imports: [HttpModule] }).compile();
    http = moduleRef.createNestApplication();
    http.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    http.useGlobalFilters(
      new AllExceptionsFilter({
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      } as never),
    );
    await http.init();
  });

  afterAll(async () => {
    await http?.close();
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM idempotency_key WHERE organization_id = ANY($1::text[])`,
      [org.a, org.b],
    );
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  /** A machine of `organizationId` in the replica, as asset-service's event would put it. */
  const machine = async (organizationId = org.a): Promise<string> => {
    const assetId = id('AST');
    const envelope: EventEnvelope = {
      eventId: id('EVT'),
      eventName: 'ASSET_CREATED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'asset-service',
      producerVersion: '0.1.0',
      aggregateType: 'Asset',
      aggregateId: assetId,
      tenantId: organizationId,
      correlationId: id('COR'),
      payload: producerShaped('ASSET_CREATED', {
        organizationId,
        assetId,
        status: 'ACTIVE',
        name: 'گریدر',
      }),
    };
    await new AssetSyncConsumer(null, repository).handle(envelope);
    return assetId;
  };

  interface Caller {
    org?: string;
    user?: string;
    roles?: string;
  }

  const withHeaders = <T extends request.Test>(req: T, who: Caller): T => {
    if (who.org) req.set('x-test-org', who.org);
    if (who.user) req.set('x-test-user', who.user);
    if (who.roles) req.set('x-test-roles', who.roles);
    return req;
  };

  const declare = (body: object, key: string | undefined, who: Caller = {}) => {
    const req = request(http.getHttpServer()).post('/v1/fleet/availability').send(body);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return withHeaders(req, who);
  };

  const revoke = (windowId: string, who: Caller = {}) =>
    withHeaders(
      request(http.getHttpServer()).post(`/v1/fleet/availability/${windowId}/revoke`),
      who,
    );

  const windows = (assetId: string, query = '', who: Caller = {}) =>
    withHeaders(
      request(http.getHttpServer()).get(
        `/v1/fleet/availability/windows?assetId=${assetId}${query}`,
      ),
      who,
    );

  const body = (assetId: string, over: Record<string, unknown> = {}) => ({
    assetId,
    available: false,
    reason: 'رزرو برای پروژه راه‌سازی',
    ...over,
  });

  const key = () => `itest-${ulid()}`;

  const rows = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ id: string; revoked_at: Date | null }[]>(
        `SELECT id, revoked_at FROM availability_window WHERE asset_id = $1 ORDER BY id`,
        assetId,
      )
    ).map((row) => ({ id: row.id, revoked: row.revoked_at !== null }));

  const eventCount = async (assetId: string): Promise<number> => {
    const found = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM outbox_message
       WHERE event_name = 'AVAILABILITY_CHANGED' AND aggregate_type = 'AvailabilityWindow'
         AND aggregate_id IN (SELECT id FROM availability_window WHERE asset_id = $1)`,
      assetId,
    );
    return found[0]?.n ?? 0;
  };

  /** A 404 as the client sees it, without what differs per request. */
  const shape = (answer: { body: Record<string, unknown> }) => ({
    code: answer.body.code,
    message: answer.body.message,
    details: answer.body.details,
    fields: Object.keys(answer.body).sort(),
  });

  describe('a retry', () => {
    it('replays the original 201 — the same window — and declares and publishes nothing more', async () => {
      const assetId = await machine();
      const k = key();

      const first = await declare(body(assetId), k);
      const second = await declare(body(assetId), k);
      const third = await declare(body(assetId), k);

      expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);
      expect(await rows(assetId)).toEqual([{ id: first.body.id, revoked: false }]);
      expect(await eventCount(assetId)).toBe(1);
    });

    it('does not undo a newer declaration when an older request is retried', async () => {
      const assetId = await machine();
      const oldKey = key();
      const old = await declare(body(assetId, { reason: 'ممنوعیت موقت برای بازرسی' }), oldKey);
      const newer = await declare(
        body(assetId, { available: true, reason: 'آماده به کار' }),
        key(),
      );

      const retried = await declare(body(assetId, { reason: 'ممنوعیت موقت برای بازرسی' }), oldKey);

      // The retry is the first request's answer; it supersedes nothing.
      expect(retried.status).toBe(201);
      expect(retried.body.id).toBe(old.body.id);
      const live = (await rows(assetId)).filter((row) => !row.revoked);
      expect(live).toEqual([{ id: newer.body.id, revoked: false }]);
    });

    it('is refused with a different body, and declares nothing more', async () => {
      const assetId = await machine();
      const k = key();
      const first = await declare(body(assetId), k);

      const changed = await declare(body(assetId, { available: true }), k);

      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(JSON.stringify(changed.body)).not.toContain(first.body.id);
      expect(await rows(assetId)).toEqual([{ id: first.body.id, revoked: false }]);
    });

    it('is refused for another machine of the same organization: the machine is part of the request', async () => {
      const assetId = await machine();
      const otherAsset = await machine();
      const k = key();
      await declare(body(assetId), k);

      const elsewhere = await declare(body(otherAsset), k);

      expect(elsewhere.status).toBe(409);
      expect(elsewhere.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await rows(otherAsset)).toEqual([]);
    });

    it('is refused from another user of the same organization, who learns nothing of the first', async () => {
      const assetId = await machine();
      const k = key();
      const first = await declare(body(assetId), k);

      const other = await declare(body(assetId), k, { user: 'USR-ITEST-OTHER' });

      expect(other.status).toBe(409);
      expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(JSON.stringify(other.body)).not.toContain(first.body.id);
    });

    it('releases the key when the declaration is refused, so a corrected retry with the same key runs', async () => {
      const assetId = await machine();
      const k = key();

      const refused = await declare(body(`AST_${ulid()}`), k);
      expect(refused.status).toBe(404);

      const corrected = await declare(body(assetId), k);
      expect(corrected.status).toBe(201);
      expect(await rows(assetId)).toEqual([{ id: corrected.body.id, revoked: false }]);
    });
  });

  describe('a concurrent double submit', () => {
    it('declares exactly one however many Promise.all submits race: one window, one event', async () => {
      const assetId = await machine();
      const k = key();

      const answers = await Promise.all(Array.from({ length: 4 }, () => declare(body(assetId), k)));

      expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201]);
      expect(new Set(answers.map((answer) => answer.body.id)).size).toBe(1);
      expect(await rows(assetId)).toHaveLength(1);
      expect(await eventCount(assetId)).toBe(1);
    });
  });

  describe('the header', () => {
    it.each([
      ['absent', undefined],
      ['blank', '   '],
      ['too short', 'short'],
      ['too long', 'k'.repeat(256)],
    ])('is required: %s → 400 VALIDATION_FAILED and nothing is declared', async (_name, k) => {
      const assetId = await machine();

      const refused = await declare(body(assetId), k);

      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(refused.body.details?.[0]?.path).toBe('Idempotency-Key');
      expect(await rows(assetId)).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it('answers another organization’s machine exactly as one that does not exist — for every write and read', async () => {
      const assetId = await machine(org.a);
      const missing = `AST_${ulid()}`;
      const own = await declare(body(assetId), key());
      const missingWindow = `AVW_${ulid()}`;

      const foreignDeclare = await declare(body(assetId), key(), { org: org.b });
      const missingDeclare = await declare(body(missing), key(), { org: org.b });
      const foreignList = await windows(assetId, '', { org: org.b });
      const missingList = await windows(missing, '', { org: org.b });
      const foreignRevoke = await revoke(own.body.id, { org: org.b });
      const missingRevoke = await revoke(missingWindow, { org: org.b });

      for (const answer of [
        foreignDeclare,
        missingDeclare,
        foreignList,
        missingList,
        foreignRevoke,
        missingRevoke,
      ]) {
        expect(answer.status).toBe(404);
        expect(answer.body.code).toBe('NOT_FOUND');
      }
      expect(shape(foreignDeclare).message).toBe(shape(missingDeclare).message);
      expect(shape(foreignList).message).toBe(shape(missingList).message);
      // The window id is in the message of a missing window and of a foreign
      // one alike, never anything that tells the two apart.
      expect(shape(foreignRevoke).fields).toEqual(shape(missingRevoke).fields);
      expect(foreignRevoke.body.message.replace(own.body.id, 'X')).toBe(
        missingRevoke.body.message.replace(missingWindow, 'X'),
      );
      // Nothing of tenant A changed.
      expect(await rows(assetId)).toEqual([{ id: own.body.id, revoked: false }]);
    });

    it('answers the original caller’s replay 404 exactly as a missing machine once it has left the tenant: no stored body, nothing written', async () => {
      const assetId = await machine(org.a);
      const k = key();
      const first = await declare(body(assetId), k);
      expect(first.status).toBe(201);
      // While the machine is still the caller's, the replay is the stored 201.
      expect((await declare(body(assetId), k)).body).toEqual(first.body);

      await prisma.client.$executeRawUnsafe(
        `UPDATE asset_ref SET organization_id = $2 WHERE id = $1`,
        assetId,
        org.b,
      );
      const eventsBefore = await eventCount(assetId);

      const replay = await declare(body(assetId), k);
      const missing = await declare(body(`AST_${ulid()}`), key());

      expect(replay.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(replay.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(replay.body)).not.toContain(first.body.id);
      expect(shape(replay).fields).toEqual(shape(missing).fields);
      expect(await eventCount(assetId)).toBe(eventsBefore);
      expect(await rows(assetId)).toEqual([{ id: first.body.id, revoked: false }]);
    });

    it('keeps keys per organization: tenant B cannot replay tenant A’s key, it declares on its own machine', async () => {
      const assetA = await machine(org.a);
      const assetB = await machine(org.b);
      const k = key();

      const a = await declare(body(assetA), k);
      const b = await declare(body(assetB), k, { org: org.b });

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.id).not.toBe(a.body.id);
    });
  });

  it('checks the role before any replay: a caller who may not declare gets 403, never the stored window', async () => {
    const assetId = await machine();
    const k = key();
    const first = await declare(body(assetId), k);

    const operator = await declare(body(assetId), k, { roles: 'OPERATOR' });

    expect(operator.status).toBe(403);
    expect(JSON.stringify(operator.body)).not.toContain(first.body.id);
  });

  describe('a machine’s declarations', () => {
    it('lists them newest first, revoked ones included, and pages by cursor', async () => {
      const assetId = await machine();
      const a = await declare(body(assetId, { reason: 'نخستین اعلام' }), key());
      const b = await declare(body(assetId, { reason: 'دومین اعلام' }), key());
      const c = await declare(body(assetId, { reason: 'سومین اعلام', available: true }), key());

      const all = await windows(assetId);
      expect(all.status).toBe(200);
      expect(all.body.items.map((w: { id: string }) => w.id)).toEqual([
        c.body.id,
        b.body.id,
        a.body.id,
      ]);
      // Each declaration supersedes the one before it; only the newest is live.
      expect(all.body.items.map((w: { revokedAt: string | null }) => w.revokedAt !== null)).toEqual(
        [false, true, true],
      );

      const firstPage = await windows(assetId, '&limit=2');
      expect(firstPage.body.items).toHaveLength(2);
      expect(firstPage.body.hasMore).toBe(true);
      const secondPage = await windows(assetId, `&limit=2&cursor=${firstPage.body.nextCursor}`);
      expect(secondPage.body.items.map((w: { id: string }) => w.id)).toEqual([a.body.id]);
      expect(secondPage.body.hasMore).toBe(false);
    });

    it('requires assetId', async () => {
      const answer = await withHeaders(
        request(http.getHttpServer()).get('/v1/fleet/availability/windows'),
        {},
      );
      expect(answer.status).toBe(400);
    });

    it('revokes a live declaration once; a second revoke is an illegal transition, not a second change', async () => {
      const assetId = await machine();
      const declared = await declare(body(assetId), key());

      const first = await revoke(declared.body.id);
      const second = await revoke(declared.body.id);

      expect(first.status).toBe(200);
      expect(first.body.revokedAt).not.toBeNull();
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('does not let an operator revoke', async () => {
      const assetId = await machine();
      const declared = await declare(body(assetId), key());

      const refused = await revoke(declared.body.id, { roles: 'OPERATOR' });

      expect(refused.status).toBe(403);
      expect((await rows(assetId))[0]?.revoked).toBe(false);
    });
  });
});
