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
import { AllExceptionsFilter, RolesGuard, runWithContext } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { AssetController } from '../src/asset/asset.controller';
import { IdempotencyStore } from '../src/asset/idempotency';
import { InsuranceService } from '../src/insurance/insurance.service';
import { ClaimService } from '../src/insurance/claim.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma, tenants } from './helpers';

/**
 * Idempotency-Key on the two records an asset takes — an insurance policy and a
 * technical inspection (EXP-002 slice 6, docs/06 § 6.8) — against real
 * PostgreSQL, behind a real HTTP stack (the platform's role guard and exception
 * filter, the caller's context set by a middleware as the request context
 * middleware does).
 *
 * Every claim is about what the database holds after the requests: how many
 * rows exist, how many events wait in the outbox, how many timeline entries
 * were written, and what each caller was answered. These POSTs create rows, so
 * without the key a replayed form records the same policy or inspection twice;
 * an inspection has no natural unique key at all, which is why the key is the
 * only thing that stops it.
 */
const day = 86_400_000;

const POLICY = (over: Record<string, unknown> = {}) => ({
  policyNumber: `POL-${ulid().slice(-8)}`,
  insurerName: 'بیمه نمونه',
  coverage: 'THIRD_PARTY',
  premiumMinor: '120000000',
  validFrom: new Date(Date.now() - day).toISOString(),
  validTo: new Date(Date.now() + 300 * day).toISOString(),
  ...over,
});

const INSPECTION = (over: Record<string, unknown> = {}) => ({
  certificateNo: `INSP-${ulid().slice(-8)}`,
  centerName: 'مرکز معاینه نمونه',
  inspectedAt: new Date(Date.now() - 2 * day).toISOString(),
  validTo: new Date(Date.now() + 360 * day).toISOString(),
  result: 'PASSED',
  ...over,
});

interface Route {
  readonly name: string;
  readonly path: (assetId: string) => string;
  readonly body: (over?: Record<string, unknown>) => Record<string, unknown>;
  readonly table: string;
  readonly aggregateType: string;
  readonly recordedEvent: string;
  /** A different body for the same record kind. */
  readonly other: Record<string, unknown>;
  /** A body the service refuses with a business rule, then corrects. */
  readonly refused: Record<string, unknown>;
  readonly corrected: Record<string, unknown>;
}

const ROUTES: readonly Route[] = [
  {
    name: 'insurance policy',
    path: (assetId) => `/v1/assets/${assetId}/insurance-policies`,
    body: POLICY,
    table: 'insurance_policy',
    aggregateType: 'InsurancePolicy',
    recordedEvent: 'INSURANCE_RECORDED',
    other: { coverage: 'COMPREHENSIVE' },
    refused: {
      validFrom: new Date(Date.now() - 400 * day).toISOString(),
      validTo: new Date(Date.now() - 35 * day).toISOString(),
    },
    corrected: {},
  },
  {
    name: 'technical inspection',
    path: (assetId) => `/v1/assets/${assetId}/inspections`,
    body: INSPECTION,
    table: 'technical_inspection',
    aggregateType: 'TechnicalInspection',
    recordedEvent: 'INSPECTION_RECORDED',
    other: { result: 'CONDITIONAL' },
    // validTo before inspectedAt is refused by the body's own rule.
    refused: { validTo: new Date(Date.now() - 10 * day).toISOString() },
    corrected: {},
  },
];

describe('recording an insurance policy or an inspection under an Idempotency-Key', () => {
  let prisma: PrismaService;
  let assets: AssetService;
  let http: INestApplication;

  const org = tenants();
  const manager = { organizationId: org.a, userId: 'USR-ITEST-MANAGER' };

  beforeAll(async () => {
    prisma = newPrisma();
    const repository = new AssetRepository(prisma);
    assets = new AssetService(repository);
    const insurance = new InsuranceService(repository, assets, 30);
    const store = new IdempotencyStore(prisma, {
      ASSET_IDEMPOTENCY_TTL_HOURS: 24,
      ASSET_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120,
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
          userId: req.headers['x-test-user'] ?? manager.userId,
          roles: (req.headers['x-test-roles'] ?? 'FLEET_MANAGER').split(','),
          organizationIds: [],
          authType: 'USER',
          startedAt: Date.now(),
        },
        () => next(),
      );
    };
    @Module({
      controllers: [AssetController],
      providers: [
        { provide: AssetService, useValue: assets },
        { provide: InsuranceService, useValue: insurance },
        { provide: ClaimService, useValue: {} },
        { provide: IdempotencyStore, useValue: store },
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
    const orgs = [org.a, org.b];
    for (const table of [
      'outbox_message',
      'idempotency_key',
      'asset_timeline_entry',
      'insurance_policy',
      'technical_inspection',
      'asset_location',
      'asset',
    ]) {
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id = ANY($1::text[])`,
        orgs,
      );
    }
    await prisma.onModuleDestroy();
  });

  const machine = async (organizationId = org.a): Promise<string> => {
    const created = await asActor({ organizationId, userId: manager.userId }, () =>
      assets.create({ name: `لودر ${ulid().slice(-6)}`, type: 'LOADER', specifications: {} }),
    );
    return created.id;
  };

  interface Caller {
    org?: string;
    user?: string;
    roles?: string;
  }

  const post = (path: string, body: object, key: string | undefined, caller: Caller = {}) => {
    let req = request(http.getHttpServer()).post(path).send(body);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    if (caller.org) req = req.set('x-test-org', caller.org);
    if (caller.user) req = req.set('x-test-user', caller.user);
    if (caller.roles) req = req.set('x-test-roles', caller.roles);
    return req;
  };

  const get = (path: string, caller: Caller = {}) => {
    let req = request(http.getHttpServer()).get(path);
    if (caller.org) req = req.set('x-test-org', caller.org);
    return req;
  };

  const rows = async (route: Route, assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM ${route.table} WHERE asset_id = $1 ORDER BY id`,
        assetId,
      )
    ).map((row) => row.id);

  const events = async (route: Route, assetId: string): Promise<Record<string, number>> => {
    const found = await prisma.client.$queryRawUnsafe<{ event_name: string; n: number }[]>(
      `SELECT event_name, count(*)::int AS n FROM outbox_message
       WHERE aggregate_type = $2 AND aggregate_id IN (SELECT id FROM ${route.table} WHERE asset_id = $1)
       GROUP BY event_name`,
      assetId,
      route.aggregateType,
    );
    return Object.fromEntries(found.map((row) => [row.event_name, row.n]));
  };

  const timeline = async (assetId: string, eventName: string): Promise<number> => {
    const found = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM asset_timeline_entry WHERE asset_id = $1 AND event_name = $2`,
      assetId,
      eventName,
    );
    return found[0]?.n ?? 0;
  };

  const key = () => `itest-${ulid()}`;

  describe.each(ROUTES)('$name', (route) => {
    describe('a retry', () => {
      it('replays the original 201 — the same record — and records and publishes nothing more', async () => {
        const assetId = await machine();
        const body = route.body();
        const k = key();

        const first = await post(route.path(assetId), body, k);
        const second = await post(route.path(assetId), body, k);
        const third = await post(route.path(assetId), body, k);

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(third.status).toBe(201);
        // The replay is the first response, byte for byte — the same id.
        expect(second.body).toEqual(first.body);
        expect(third.body).toEqual(first.body);

        expect(await rows(route, assetId)).toEqual([first.body.id]);
        expect(await events(route, assetId)).toEqual({ [route.recordedEvent]: 1 });
        expect(await timeline(assetId, route.recordedEvent)).toBe(1);
      });

      it('is refused with a different body, and records nothing more', async () => {
        const assetId = await machine();
        const body = route.body();
        const k = key();
        const first = await post(route.path(assetId), body, k);

        const changed = await post(route.path(assetId), { ...body, ...route.other }, k);

        expect(changed.status).toBe(409);
        expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        // And says nothing of the stored response.
        expect(JSON.stringify(changed.body)).not.toContain(first.body.id);
        expect(await rows(route, assetId)).toEqual([first.body.id]);
        expect(await events(route, assetId)).toEqual({ [route.recordedEvent]: 1 });
      });

      it('is refused on another asset of the same organization: the asset is part of the request', async () => {
        const assetId = await machine();
        const otherAsset = await machine();
        const body = route.body();
        const k = key();
        const first = await post(route.path(assetId), body, k);

        const elsewhere = await post(route.path(otherAsset), body, k);

        expect(elsewhere.status).toBe(409);
        expect(elsewhere.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(await rows(route, otherAsset)).toEqual([]);
        expect(await rows(route, assetId)).toEqual([first.body.id]);
      });

      it('is refused from another user of the same organization, who learns nothing of the first', async () => {
        const assetId = await machine();
        const body = route.body();
        const k = key();
        const first = await post(route.path(assetId), body, k);

        const other = await post(route.path(assetId), body, k, { user: 'USR-ITEST-OTHER' });

        expect(other.status).toBe(409);
        expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(JSON.stringify(other.body)).not.toContain(first.body.id);
        expect(await rows(route, assetId)).toEqual([first.body.id]);
      });

      it('releases the key when the recording is refused, so a corrected retry with the same key runs', async () => {
        const assetId = await machine();
        const k = key();

        const refused = await post(route.path(assetId), route.body(route.refused), k);
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(refused.status).toBeLessThan(500);
        expect(await rows(route, assetId)).toEqual([]);

        const corrected = await post(route.path(assetId), route.body(route.corrected), k);
        expect(corrected.status).toBe(201);
        expect(await rows(route, assetId)).toEqual([corrected.body.id]);
      });
    });

    describe('a concurrent double submit', () => {
      it('records exactly one however many Promise.all submits race: one row, one event, one entry', async () => {
        const assetId = await machine();
        const body = route.body();
        const k = key();

        const answers = await Promise.all(
          Array.from({ length: 4 }, () => post(route.path(assetId), body, k)),
        );

        expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201, 201]);
        expect(new Set(answers.map((answer) => answer.body.id)).size).toBe(1);
        expect(await rows(route, assetId)).toHaveLength(1);
        expect(await events(route, assetId)).toEqual({ [route.recordedEvent]: 1 });
        expect(await timeline(assetId, route.recordedEvent)).toBe(1);
      });
    });

    describe('the header', () => {
      it.each([
        ['absent', undefined],
        ['blank', '   '],
        ['too short', 'short'],
        ['too long', 'k'.repeat(256)],
      ])('is required: %s → 400 VALIDATION_FAILED and nothing is recorded', async (_name, k) => {
        const assetId = await machine();

        const refused = await post(route.path(assetId), route.body(), k);

        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('VALIDATION_FAILED');
        expect(refused.body.details?.[0]?.path).toBe('Idempotency-Key');
        expect(await rows(route, assetId)).toEqual([]);
      });
    });

    describe('tenant isolation', () => {
      it('answers another organization’s asset exactly as one that does not exist — for the write and for the read', async () => {
        const assetId = await machine(org.a);
        const missing = `AST_${ulid()}`;
        const k = key();

        const foreignWrite = await post(route.path(assetId), route.body(), k, { org: org.b });
        const missingWrite = await post(route.path(missing), route.body(), k, { org: org.b });
        const foreignRead = await get(route.path(assetId), { org: org.b });
        const missingRead = await get(route.path(missing), { org: org.b });

        for (const answer of [foreignWrite, missingWrite, foreignRead, missingRead]) {
          expect(answer.status).toBe(404);
          expect(answer.body.code).toBe('NOT_FOUND');
        }
        expect(foreignWrite.body.message).toBe(missingWrite.body.message);
        expect(foreignRead.body.message).toBe(missingRead.body.message);
        expect(await rows(route, assetId)).toEqual([]);
        expect(await events(route, assetId)).toEqual({});
      });

      it('keeps keys per organization: tenant B cannot replay tenant A’s key, it records on its own asset', async () => {
        const assetA = await machine(org.a);
        const assetB = await machine(org.b);
        // Each tenant sends its own record: the policy number is unique per
        // insurer platform-wide, so the same
        // body would be refused for a reason that has nothing to do with keys.
        const k = key();

        const a = await post(route.path(assetA), route.body(), k);
        const b = await post(route.path(assetB), route.body(), k, { org: org.b });

        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        expect(b.body.id).not.toBe(a.body.id);
        expect(await rows(route, assetA)).toEqual([a.body.id]);
        expect(await rows(route, assetB)).toEqual([b.body.id]);
      });

      it('lists only the organization’s own records', async () => {
        const assetA = await machine(org.a);
        const recorded = await post(route.path(assetA), route.body(), key());

        const own = await get(route.path(assetA));
        const foreign = await get(route.path(assetA), { org: org.b });

        expect(own.status).toBe(200);
        expect(own.body.map((record: { id: string }) => record.id)).toEqual([recorded.body.id]);
        expect(foreign.status).toBe(404);
      });
    });

    it('checks the role before any replay: a caller who may not record gets 403, never the stored record', async () => {
      const assetId = await machine();
      const body = route.body();
      const k = key();
      const first = await post(route.path(assetId), body, k);

      const operator = await post(route.path(assetId), body, k, { roles: 'OPERATOR' });

      expect(operator.status).toBe(403);
      expect(JSON.stringify(operator.body)).not.toContain(first.body.id);
      expect(await rows(route, assetId)).toEqual([first.body.id]);
    });
  });

  it('a failed inspection announces its failure once, however often the form is replayed', async () => {
    const route = ROUTES[1]!;
    const assetId = await machine();
    const body = route.body({ result: 'FAILED', notes: 'ترمز دستی عیب دارد' });
    const k = key();

    await post(route.path(assetId), body, k);
    await post(route.path(assetId), body, k);

    expect(await events(route, assetId)).toEqual({
      INSPECTION_RECORDED: 1,
      INSPECTION_FAILED: 1,
    });
  });

  it('records the same policy number twice under two keys as one row: the unique index still stands', async () => {
    const route = ROUTES[0]!;
    const assetId = await machine();
    const body = route.body();

    const first = await post(route.path(assetId), body, key());
    const second = await post(route.path(assetId), body, key());

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_EXISTS');
    expect(await rows(route, assetId)).toEqual([first.body.id]);
  });
});
