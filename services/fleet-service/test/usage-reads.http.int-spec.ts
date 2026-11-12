import { randomBytes } from 'node:crypto';
import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxRelay,
  type AuthGuardOptions,
  type TokenVerifier,
} from '@rasta/nest-common';
import { mintTestInternalToken } from '@rasta/testing';
import { AppModule } from '../src/app.module';
import { ENV } from '../src/tokens';
import { loadFleetEnv, SERVICE_NAME } from '../src/config/env';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { meterUsagePageSchema } from '../src/fleet/meter-usage';
import { asActor, cleanup, databaseUrl, id, tenants } from './helpers';

/** Both real HTTP authorization and real PostgreSQL ordering/tenant predicates. */
describe('EXP-007 PR 9 usage reads: tenant isolation and physical meter boundary', () => {
  const org = tenants();
  const assetId = id('AST');
  const otherAsset = id('AST');
  const driverA = id('DRV');
  const driverOther = id('DRV');
  const userA = id('USR');
  const reference = `reference-${id('R')}`;
  const secret = randomBytes(32).toString('hex');
  const tokenKey = { secret, issuer: 'rasta-internal', ttlSeconds: 300 };
  let app: INestApplication;
  let prisma: PrismaService;
  let recordA: string;
  let recordB: string;

  beforeAll(async () => {
    const env = loadFleetEnv({
      ...process.env,
      NODE_ENV: 'test',
      KAFKA_ALLOW_PLAINTEXT: 'true',
      DATABASE_URL: databaseUrl(),
      KAFKA_BROKERS: 'localhost:9092',
      OIDC_ISSUER_URL: 'http://auth.invalid/realms/rasta',
      OIDC_JWKS_URI: 'http://auth.invalid/realms/rasta/certs',
      OIDC_AUDIENCE: 'rasta-api',
      INTERNAL_TOKEN_SECRET: secret,
      INTERNAL_TOKEN_ISSUER: tokenKey.issuer,
      ASSET_SERVICE_URL: 'http://127.0.0.1:9',
      MAINTENANCE_SERVICE_URL: 'http://127.0.0.1:9',
      IDENTITY_SERVICE_URL: 'http://127.0.0.1:9',
    });
    const users = {
      self: { organizationId: org.a, userId: userA, role: 'DRIVER' },
      supervisor: { organizationId: org.a, userId: id('USR'), role: 'FLEET_MANAGER' },
      tenantB: { organizationId: org.b, userId: id('USR'), role: 'FLEET_MANAGER' },
      noDriver: { organizationId: org.a, userId: id('USR'), role: 'DRIVER' },
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(env)
      .overrideProvider(OutboxRelay)
      .useValue({ start: () => undefined, stop: async () => undefined })
      .overrideProvider(AssetSyncConsumer)
      .useValue({ onModuleInit: async () => undefined, stop: async () => undefined })
      .overrideProvider(AUTH_OPTIONS)
      .useValue({
        serviceName: SERVICE_NAME,
        internalTokens: new InternalTokenService(secret, tokenKey.issuer, 300),
        tokenVerifier: {
          verifyUserToken: async (token: string) => {
            const user = users[token as keyof typeof users];
            if (!user) throw new Error('Unknown test user');
            return {
              sub: user.userId,
              roles: [],
              organizationId: user.organizationId,
              organizationIds: [user.organizationId],
              organizationRoles: [`${user.organizationId}:${user.role}`],
            };
          },
        } as unknown as TokenVerifier,
      } satisfies AuthGuardOptions)
      .compile();
    app = module.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    prisma = app.get(PrismaService);
    await asActor({ organizationId: org.a }, async () => {
      await prisma.client.driver.createMany({
        data: [
          {
            id: driverA,
            organizationId: org.a,
            userId: userA,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
          {
            id: driverOther,
            organizationId: org.a,
            userId: id('USR'),
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        ],
      });
    });
    recordA = await insert(org.a, assetId, '2026-01-01T01:00:00Z', {
      driverId: driverOther,
      clientReference: reference,
    });
    recordB = await insert(org.b, assetId, '2026-01-01T02:00:00Z', { clientReference: reference });
  });
  afterAll(async () => {
    if (prisma) await cleanup(prisma, [org.a, org.b]);
    await app?.close();
  });

  async function insert(
    organizationId: string,
    asset: string,
    end: string,
    extra: { id?: string; driverId?: string; clientReference?: string } = {},
  ): Promise<string> {
    const recordId = extra.id ?? id('USG');
    await asActor({ organizationId }, () =>
      prisma.client.usageRecord.create({
        data: {
          id: recordId,
          organizationId,
          assetId: asset,
          periodStart: new Date('2025-12-31T00:00:00Z'),
          periodEnd: new Date(end),
          hours: '1.25',
          kilometres: '2.50',
          hourMeter: '9999999999.99',
          odometer: null,
          recordedBy: 'ITEST',
          notes: 'private',
          ...extra,
        },
      }),
    );
    return recordId;
  }
  const publicRead = (user: string, clientReference = reference) =>
    request(app.getHttpServer())
      .get('/v1/usage-records')
      .auth(user, { type: 'bearer' })
      .query({ clientReference });
  async function internalRead(
    query: Record<string, string | number | undefined>,
    caller = 'maintenance-service',
  ) {
    const token = await mintTestInternalToken(tokenKey, caller, SERVICE_NAME, 'SERVICE', org.a);
    return request(app.getHttpServer())
      .get('/v1/internal/usage-records')
      .set('x-internal-token', token)
      .query(query);
  }

  it('SELF cannot find a colleague’s reference; supervisor can, without reading tenant B', async () => {
    const own = await publicRead('self');
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ items: [], nextCursor: null, hasMore: false });
    const supervisor = await publicRead('supervisor');
    expect(supervisor.status).toBe(200);
    expect(supervisor.body.items).toHaveLength(1);
    expect(supervisor.body.items[0].id).toBe(recordA);
    const tenantB = await publicRead('tenantB');
    expect(tenantB.status).toBe(200);
    expect(tenantB.body.items).toHaveLength(1);
    expect(tenantB.body.items[0].id).toBe(recordB);
  });

  it('returns SELF’s own matching row, exact equality only, and no retirement claim', async () => {
    const ownRef = `own-${id('R')}`;
    const ownId = await insert(org.a, otherAsset, '2026-02-01T01:00:00Z', {
      driverId: driverA,
      clientReference: ownRef,
    });
    const result = await publicRead('self', ownRef);
    expect(result.status).toBe(200);
    expect(result.body.items.map((row: { id: string }) => row.id)).toEqual([ownId]);
    expect((await publicRead('supervisor', ownRef.slice(0, -1))).body.items).toEqual([]);
    expect((await publicRead('noDriver', ownRef)).body.items).toEqual([]);
    expect(result.body).not.toHaveProperty('outcome');
  });

  it.each(['self', 'supervisor'])(
    'refuses user token %s on internal collection, even with an internal token',
    async (user) => {
      const token = await mintTestInternalToken(
        tokenKey,
        'maintenance-service',
        SERVICE_NAME,
        'SERVICE',
        org.a,
      );
      for (const headers of [{}, { 'x-internal-token': token }]) {
        const result = await request(app.getHttpServer())
          .get('/v1/internal/usage-records')
          .auth(user, { type: 'bearer' })
          .set(headers)
          .query({ assetId });
        expect(result.status).toBe(403);
        expect(result.body.code).toBe('FORBIDDEN');
      }
    },
  );

  it.each(['economic-service', 'asset-service', 'api-gateway'])(
    'refuses other service %s',
    async (caller) => {
      expect((await internalRead({ assetId }, caller)).status).toBe(403);
    },
  );

  it('crosses owners only for maintenance, returning exactly eight meter fields as strings', async () => {
    const result = await internalRead({ assetId });
    expect(result.status).toBe(200);
    const page = meterUsagePageSchema.parse(result.body);
    expect(page.items.map((row) => row.id)).toEqual([recordA, recordB]);
    expect(page.items.map((row) => row.organizationId)).toEqual([org.a, org.b]);
    expect(page.items[0]).toMatchObject({
      hours: '1.25',
      kilometres: '2.50',
      hourMeter: '9999999999.99',
      odometer: null,
    });
  });

  it('pages completely without duplicate or missing existing rows, including equal-end ties and concurrent inserts', async () => {
    const asset = id('AST');
    const ids = [id('USG'), id('USG'), id('USG'), id('USG'), id('USG')].sort();
    // Insert ties in reverse physical order: ORDER BY without id must fail.
    for (const recordId of [...ids].reverse())
      await insert(org.a, asset, '2026-03-01T01:00:00Z', { id: recordId });
    let result = await internalRead({ assetId: asset, limit: 2 });
    expect(result.status).toBe(200);
    let page = meterUsagePageSchema.parse(result.body);
    const seen = page.items.map((row) => row.id);
    expect(seen).toEqual(ids.slice(0, 2));
    const tiedId = `${ids[2]!}z`;
    const later = await Promise.all([
      insert(org.b, asset, '2026-03-01T01:00:00Z', { id: tiedId }),
      insert(org.b, asset, '2026-03-01T02:00:00Z'),
      insert(org.a, otherAsset, '2026-03-01T01:00:00Z'),
    ]);
    for (let n = 0; page.hasMore && n < 10; n++) {
      expect(page.nextCursor).not.toBeNull();
      result = await internalRead({ assetId: asset, limit: 2, cursor: page.nextCursor! });
      expect(result.status).toBe(200);
      page = meterUsagePageSchema.parse(result.body);
      seen.push(...page.items.map((row) => row.id));
    }
    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(seen).toEqual([...ids, tiedId].sort().concat(later[1]!));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects malformed/tampered/mismatched cursors and invalid queries with 400 before a read', async () => {
    const first = await internalRead({ assetId, limit: 1 });
    expect(first.status).toBe(200);
    const cursor = meterUsagePageSchema.parse(first.body).nextCursor!;
    const repoSpy = jest.spyOn(app.get(FleetRepository), 'listMeterUsage');
    try {
      for (const query of [
        {},
        { assetId, limit: 201 },
        { assetId, cursor: '' },
        { assetId, cursor: 'garbage' },
        { assetId, cursor: `${cursor}x` },
        {
          assetId,
          cursor: Buffer.from(
            JSON.stringify([assetId, '2026-01-01T03:00:00.000Z', recordA]),
          ).toString('base64url'),
        },
        {
          assetId,
          cursor: Buffer.from(
            JSON.stringify([assetId, '2026-01-01T01:00:00.000Z', id('USG')]),
          ).toString('base64url'),
        },
        { assetId: otherAsset, cursor },
        { assetId, organizationId: org.b },
      ]) {
        expect((await internalRead(query)).status).toBe(400);
      }
      expect(repoSpy).not.toHaveBeenCalled();
    } finally {
      repoSpy.mockRestore();
    }
  });
});
