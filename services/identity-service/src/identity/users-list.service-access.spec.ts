import 'reflect-metadata';
import {
  Module,
  VersioningType,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import request from 'supertest';
import {
  ALLOW_SERVICE_KEY,
  AllExceptionsFilter,
  AuthGuard,
  AUTH_OPTIONS,
  EXCEPTION_FILTER_LOGGER,
  getContext,
  getOrganizationId,
  InternalTokenService,
  RequestContextMiddleware,
  RolesGuard,
  type AuthGuardOptions,
  type RequestContext,
  type TokenVerifier,
  type UserClaims,
} from '@rasta/nest-common';
import { UserController } from './identity.controller';
import { IdentityService } from './identity.service';

/**
 * `GET /v1/users` is callable by notification-service — and by nothing else
 * that was not already allowed (ADR-054 § 1, ADR-020, ADR-035).
 *
 * The real controller behind the real `AuthGuard` and `RolesGuard`, with
 * `IdentityService` replaced by a recorder that behaves like the repository
 * on the one point that matters: it asks `getOrganizationId()` before it
 * answers, exactly as the tenant guard does for the membership query. So a
 * service token minted without a signed `org_id` is refused here the same way
 * it is refused in production — as a 403, never as a list.
 *
 * Positive and negative for every kind of caller, on the endpoint that
 * changed and on its neighbours that must not have.
 */

const SECRET = 'identity_unit_test_internal_secret_32_chars!';
const ISSUER = 'rasta-internal';
const ORG_A = 'ORG_A';
const ORG_B = 'ORG_B';

interface Recorded {
  context: RequestContext;
  organizationId: string;
}

const recorded: Recorded[] = [];

/** The only three behaviours the controller needs from the service here. */
const serviceStub = {
  listUsers: async () => {
    const context = getContext();
    const organizationId = getOrganizationId();
    recorded.push({ context, organizationId });
    return {
      items: [{ id: 'USR_1', status: 'ACTIVE', roles: ['FLEET_MANAGER'] }],
      nextCursor: null,
      hasMore: false,
    };
  },
  getCurrentUser: async () => ({ id: 'USR_ME' }),
  createUser: async () => ({ id: 'USR_NEW' }),
};

/** User tokens are opaque strings mapped to claims; no JWKS is contacted. */
const userTokens = new Map<string, UserClaims>();

function userToken(name: string, roles: string[], organizationId = ORG_A): string {
  const token = `user-${name}`;
  userTokens.set(token, {
    sub: `kc-${name}`,
    rastaUserId: `USR_${name}`,
    organizationId,
    organizationIds: [organizationId],
    roles,
    // The role in the organization it was granted in (ADR-060).
    organizationRoles: roles.map((role) => `${organizationId}:${role}`),
    expiresAt: Date.now() + 60_000,
  });
  return token;
}

const tokenVerifier = {
  verifyUserToken: async (token: string) => {
    const claims = userTokens.get(token);
    if (!claims) throw new Error('unknown test token');
    return claims;
  },
} as unknown as TokenVerifier;

const internalTokens = new InternalTokenService(SECRET, ISSUER, 300);

@Module({
  controllers: [UserController],
  providers: [
    { provide: IdentityService, useValue: serviceStub },
    { provide: InternalTokenService, useValue: internalTokens },
    {
      provide: AUTH_OPTIONS,
      useValue: {
        serviceName: 'identity-service',
        tokenVerifier,
        internalTokens,
      } satisfies AuthGuardOptions,
    },
    {
      provide: EXCEPTION_FILTER_LOGGER,
      useValue: {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

describe('GET /v1/users service access (ADR-054 § 1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    recorded.length = 0;
  });

  const server = () => app.getHttpServer();

  it('declares the allowance on exactly one handler, naming notification-service alone', () => {
    const prototype = UserController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(ALLOW_SERVICE_KEY, prototype.list as object)).toEqual([
      'notification-service',
    ]);
    for (const handler of [
      'getCurrentUser',
      'switchOrganization',
      'get',
      'create',
      'update',
      'addMembership',
    ]) {
      expect(Reflect.getMetadata(ALLOW_SERVICE_KEY, prototype[handler] as object)).toBeUndefined();
    }
  });

  it('accepts a SERVICE token from notification-service and scopes the call to its signed org_id', async () => {
    const token = await internalTokens.issue(
      'notification-service',
      'identity-service',
      'SERVICE',
      ORG_A,
    );
    const response = await request(server())
      .get('/v1/users?role=FLEET_MANAGER&status=ACTIVE&limit=200')
      .set('x-internal-token', token);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.organizationId).toBe(ORG_A);
    expect(recorded[0]!.context.authType).toBe('SERVICE');
    expect(recorded[0]!.context.callerService).toBe('notification-service');
    expect(recorded[0]!.context.userId).toBeUndefined();
  });

  it('refuses a SERVICE token from any other service', async () => {
    for (const caller of [
      'marketplace-service',
      'audit-service',
      'api-gateway',
      'notification-service-2',
    ]) {
      const token = await internalTokens.issue(caller, 'identity-service', 'SERVICE', ORG_A);
      const response = await request(server()).get('/v1/users').set('x-internal-token', token);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
    expect(recorded).toHaveLength(0);
  });

  it('refuses a token minted for another target service', async () => {
    const token = await internalTokens.issue(
      'notification-service',
      'economic-service',
      'SERVICE',
      ORG_A,
    );
    const response = await request(server()).get('/v1/users').set('x-internal-token', token);
    expect(response.status).toBe(401);
    expect(recorded).toHaveLength(0);
  });

  it('refuses a RELAY token: the gateway cannot mint service authority (D-007)', async () => {
    const token = await internalTokens.issue('api-gateway', 'identity-service', 'RELAY');
    const response = await request(server()).get('/v1/users').set('x-internal-token', token);
    expect(response.status).toBe(401);
    expect(recorded).toHaveLength(0);
  });

  it('refuses a SERVICE token without a signed org_id: a platform-wide listing is not on offer', async () => {
    const token = await internalTokens.issue('notification-service', 'identity-service', 'SERVICE');
    const response = await request(server()).get('/v1/users').set('x-internal-token', token);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
    expect(recorded).toHaveLength(0);
  });

  it('refuses an X-Organization-Id header that disagrees with the signed claim (ADR-035)', async () => {
    const token = await internalTokens.issue(
      'notification-service',
      'identity-service',
      'SERVICE',
      ORG_A,
    );
    const response = await request(server())
      .get('/v1/users')
      .set('x-internal-token', token)
      .set('x-organization-id', ORG_B);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
    expect(recorded).toHaveLength(0);

    // Agreement is fine, and still resolves to the claim.
    const agreeing = await request(server())
      .get('/v1/users')
      .set('x-internal-token', token)
      .set('x-organization-id', ORG_A);
    expect(agreeing.status).toBe(200);
    expect(recorded[0]!.organizationId).toBe(ORG_A);
  });

  it('refuses the notification-service token on every neighbouring endpoint', async () => {
    const token = await internalTokens.issue(
      'notification-service',
      'identity-service',
      'SERVICE',
      ORG_A,
    );
    expect(
      (await request(server()).get('/v1/users/me').set('x-internal-token', token)).status,
    ).toBe(403);
    expect(
      (await request(server()).get('/v1/users/USR_1').set('x-internal-token', token)).status,
    ).toBe(403);
    expect(
      (await request(server()).post('/v1/users').set('x-internal-token', token).send({})).status,
    ).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it('leaves human access exactly as it was: admins in, everybody else out', async () => {
    const admin = await request(server())
      .get('/v1/users')
      .set('authorization', `Bearer ${userToken('admin', ['ORGANIZATION_ADMIN'])}`);
    expect(admin.status).toBe(200);
    expect(recorded[0]!.context.authType).toBe('USER');
    expect(recorded[0]!.organizationId).toBe(ORG_A);

    const union = await request(server())
      .get('/v1/users')
      .set('authorization', `Bearer ${userToken('union', ['UNION_ADMIN'])}`);
    expect(union.status).toBe(200);

    for (const role of ['FLEET_MANAGER', 'DRIVER', 'AUDITOR', 'SUPPLIER']) {
      const response = await request(server())
        .get('/v1/users')
        .set('authorization', `Bearer ${userToken(role.toLowerCase(), [role])}`);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('INSUFFICIENT_ROLE');
    }
  });

  it('refuses an anonymous call', async () => {
    const response = await request(server()).get('/v1/users');
    expect(response.status).toBe(401);
    expect(recorded).toHaveLength(0);
  });

  it('prefers the user token when both are present, so a relayed human is judged as a human', async () => {
    const relay = await internalTokens.issue('api-gateway', 'identity-service', 'RELAY');
    const response = await request(server())
      .get('/v1/users')
      .set('x-internal-token', relay)
      .set('authorization', `Bearer ${userToken('driver2', ['DRIVER'])}`);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_ROLE');
  });
});
