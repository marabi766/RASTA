import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ulid } from 'ulid';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxRelay,
  type AuthGuardOptions,
  type TokenVerifier,
} from '@rasta/nest-common';
import { AppModule } from '../src/app.module';
import { ENV } from '../src/tokens';
import { loadFleetEnv, SERVICE_NAME } from '../src/config/env';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  CLEARANCE_CALLER,
  CLEARANCE_CLOCK,
  CLEARANCE_HANDLER_MAX_MS,
} from '../src/fleet/transfer-clearance';
import { cleanup, databaseUrl, id, tenants } from './helpers';

/**
 * The clearance bound over HTTP, through the real module wiring (review #127
 * round 4, #1): the bound runs from the request's arrival, stamped by
 * `ClearanceArrivalMiddleware` before the auth guard — not from the handler.
 *
 * The internal-token verification is made slow on the clearance clock: it
 * advances the clock past the bound while the request is still in the guard.
 * A handler-started clock would see no time pass and fence; the arrival stamp
 * makes the same request a withdrawal.
 */
describe('transfer clearance over HTTP: the bound runs from arrival', () => {
  const org = tenants();
  const secret = `itest-${'x'.repeat(40)}`;
  const tokens = new InternalTokenService(secret, 'rasta-internal', 300);
  let app: INestApplication;
  let prisma: PrismaService;
  let now = 0;
  /** How far the next token verification moves the clearance clock. */
  let verificationTakes = 0;

  beforeAll(async () => {
    const env = loadFleetEnv({
      ...process.env,
      NODE_ENV: 'test',
      // The relay and consumers are inert: nothing here reaches the broker, so
      // the app may be built without the service's broker credential — the
      // explicit opt-out, honoured only under NODE_ENV test (RUN-006).
      KAFKA_ALLOW_PLAINTEXT: process.env.KAFKA_ALLOW_PLAINTEXT ?? 'true',
      DATABASE_URL: databaseUrl(),
      KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
      OIDC_ISSUER_URL: 'http://auth.invalid/realms/rasta',
      OIDC_JWKS_URI: 'http://auth.invalid/realms/rasta/certs',
      OIDC_AUDIENCE: 'rasta-api',
      INTERNAL_TOKEN_SECRET: secret,
      INTERNAL_TOKEN_ISSUER: 'rasta-internal',
      ASSET_SERVICE_URL: 'http://127.0.0.1:9',
    });
    const inert = { start: () => undefined, stop: async () => undefined };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(env)
      .overrideProvider(OutboxRelay)
      .useValue(inert)
      .overrideProvider(AssetSyncConsumer)
      .useValue({ onModuleInit: async () => undefined, onModuleDestroy: async () => undefined })
      .overrideProvider(CLEARANCE_CLOCK)
      .useValue(() => now)
      .overrideProvider(AUTH_OPTIONS)
      .useValue({
        serviceName: SERVICE_NAME,
        tokenVerifier: {
          verifyUserToken: async () => {
            throw new Error('no user token in this suite');
          },
        } as unknown as TokenVerifier,
        internalTokens: {
          verify: async (token: string, target: string) => {
            now += verificationTakes;
            return tokens.verify(token, target);
          },
        } as unknown as InternalTokenService,
      } satisfies AuthGuardOptions)
      .compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup(prisma, [org.a]);
  }, 60_000);

  afterAll(async () => {
    await cleanup(prisma, [org.a]);
    await app?.close();
  });

  async function machine(): Promise<string> {
    const assetId = id('AST');
    const replica = new AssetSyncConsumer(null, app.get(FleetRepository));
    await replica.handle({
      eventId: id('EVT'),
      eventName: 'ASSET_CREATED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'asset-service',
      producerVersion: '0.1.0',
      aggregateType: 'Asset',
      aggregateId: assetId,
      tenantId: org.a,
      correlationId: id('COR'),
      payload: { assetId, organizationId: org.a, status: 'ACTIVE' },
    });
    return assetId;
  }

  const fences = async (assetId: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM asset_transfer_fence WHERE asset_id = $1`,
        assetId,
      )
    )[0]!.n;

  async function clear(assetId: string) {
    const token = await tokens.issue(CLEARANCE_CALLER, SERVICE_NAME, 'SERVICE', org.a);
    return request(app.getHttpServer())
      .post(`/v1/internal/assets/${assetId}/transfer-clearance`)
      .set('x-internal-token', token)
      .send({ fenceId: `TRF_${ulid()}`, ttlSeconds: 600 });
  }

  it('fences when the request reaches the lock within the bound', async () => {
    const assetId = await machine();
    verificationTakes = 1;

    const response = await clear(assetId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ clear: true, openAssignments: 0 });
    expect(await fences(assetId)).toBe(1);
  });

  it('withdraws, and fences nothing, when the request was held past the bound before its handler ran', async () => {
    const assetId = await machine();
    // Held in the auth guard's token verification — after arrival, before
    // `clear()` — for longer than the bound.
    verificationTakes = CLEARANCE_HANDLER_MAX_MS + 1;

    const response = await clear(assetId);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(await fences(assetId)).toBe(0);
  });
});
