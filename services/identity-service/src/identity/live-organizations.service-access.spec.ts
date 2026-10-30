import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
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
  AllExceptionsFilter,
  AuthGuard,
  AUTH_OPTIONS,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  RequestContextMiddleware,
  RolesGuard,
  type AuthGuardOptions,
  type TokenVerifier,
  type UserClaims,
} from '@rasta/nest-common';
import { mintTestInternalToken, type TestInternalTokenKey } from '@rasta/testing';
import { SwaggerModule } from '@nestjs/swagger';
import { identityDocumentConfig } from '../openapi-config';
import { INTERNAL_TOKEN_SCHEME, UserController } from './identity.controller';
import { IdentityService } from './identity.service';

/**
 * `GET /v1/users/:id/organizations` over HTTP, for its two callers (CON-002 PR 8;
 * ADR-070 § 7, PR 5): construction-service and procurement-service, each with a token
 * signed for **no tenant**. Everybody else is refused: a person with any role, any
 * other service, a tenant-signed token, a relay.
 *
 * The real controller behind the real `AuthGuard` and `RolesGuard`, and the real
 * `IdentityService` over a repository that records what it was asked. So both layers
 * are on the path: `@AllowService` refuses another service before the handler runs,
 * and the service's own caller check refuses a tenant-signed token the guard lets
 * through. The repository is never asked for a refused call.
 */

const SECRET = randomBytes(24).toString('hex');
const ISSUER = 'rasta-internal';
const ORG_A = 'ORG_A';
const DB_NOW = new Date('2026-10-17T10:00:00.000Z');

const asked: { userId: string; from?: string }[] = [];

const repository = {
  findLiveMemberships: async (userId: string) => {
    asked.push({ userId });
    return { memberships: [{ organizationId: ORG_A, roles: ['OPERATOR'] }], asOf: DB_NOW };
  },
  findOrganizationIdsSince: async (userId: string, from: Date) => {
    asked.push({ userId, from: from.toISOString() });
    return { organizationIds: [ORG_A], asOf: DB_NOW };
  },
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
const tokenKey: TestInternalTokenKey = { secret: SECRET, issuer: ISSUER, ttlSeconds: 300 };

@Module({
  controllers: [UserController],
  providers: [
    {
      provide: IdentityService,
      useValue: new IdentityService(repository as never, {} as never, {} as never),
    },
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

describe('GET /v1/users/:id/organizations service access (CON-002 PR 8, ADR-070 § 7)', () => {
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
    asked.length = 0;
  });

  const path = '/v1/users/USR_1/organizations';
  const service = (caller: string, organizationId?: string, audience = 'identity-service') =>
    mintTestInternalToken(tokenKey, caller, audience, 'SERVICE', organizationId);
  const ask = async (token: string, query = '') =>
    request(app.getHttpServer()).get(`${path}${query}`).set('x-internal-token', token);

  it.each(['construction-service', 'procurement-service'])(
    'answers %s with a tenant-less token: live memberships, and the interval from an instant',
    async (caller) => {
      const live = await ask(await service(caller));
      expect(live.status).toBe(200);
      expect(live.body).toEqual({
        userId: 'USR_1',
        memberships: [{ organizationId: ORG_A, roles: ['OPERATOR'] }],
        asOf: DB_NOW.toISOString(),
      });

      const since = await ask(await service(caller), '?from=2026-10-01T00:00:00.000Z');
      expect(since.status).toBe(200);
      expect(since.body).toEqual({
        userId: 'USR_1',
        organizationIds: [ORG_A],
        asOf: DB_NOW.toISOString(),
      });
      expect(asked).toEqual([
        { userId: 'USR_1' },
        { userId: 'USR_1', from: '2026-10-01T00:00:00.000Z' },
      ]);
    },
  );

  it.each(['construction-service', 'procurement-service'])(
    'refuses %s with a token signed for a tenant: 403, and reads nothing',
    async (caller) => {
      const response = await ask(await service(caller, ORG_A));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
      expect(asked).toHaveLength(0);
    },
  );

  it('refuses every other service, tenant-less or not: 403, and reads nothing', async () => {
    for (const caller of [
      // fleet-service asks only the one-bit question (task 095), never this one.
      'fleet-service',
      'notification-service',
      'marketplace-service',
      'supplier-service',
      'api-gateway',
      'procurement-service-2',
    ]) {
      for (const organizationId of [undefined, ORG_A]) {
        const response = await ask(await service(caller, organizationId));
        expect({ caller, organizationId, status: response.status }).toEqual({
          caller,
          organizationId,
          status: 403,
        });
      }
    }
    expect(asked).toHaveLength(0);
  });

  it('refuses a person with any role, including one relayed by the gateway', async () => {
    for (const roles of [
      ['SYSTEM_ADMIN'],
      ['ORGANIZATION_ADMIN'],
      ['UNION_ADMIN'],
      ['PROCUREMENT_USER'],
      ['AUDITOR'],
    ]) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('authorization', `Bearer ${userToken(roles[0]!.toLowerCase(), roles)}`);
      expect({ roles, status: response.status }).toEqual({ roles, status: 403 });
    }
    // A relayed human is judged as the human, never as the relay.
    const relayed = await request(app.getHttpServer())
      .get(path)
      .set(
        'x-internal-token',
        await mintTestInternalToken(tokenKey, 'api-gateway', 'identity-service', 'RELAY'),
      )
      .set('authorization', `Bearer ${userToken('relayed', ['PROCUREMENT_USER'])}`);
    expect(relayed.status).toBe(403);
    expect(asked).toHaveLength(0);
  });

  it('refuses no token, a relay token alone, and a procurement-service token minted for another service: 401', async () => {
    expect((await request(app.getHttpServer()).get(path)).status).toBe(401);
    expect(
      (await ask(await mintTestInternalToken(tokenKey, 'api-gateway', 'identity-service', 'RELAY')))
        .status,
    ).toBe(401);
    expect(
      (await ask(await service('procurement-service', undefined, 'supplier-service'))).status,
    ).toBe(401);
    expect(asked).toHaveLength(0);
  });

  it('is documented under the internal service token (X-Internal-Token), not the bearer', () => {
    const document = SwaggerModule.createDocument(app, identityDocumentConfig('test'));
    expect(document.components?.securitySchemes?.[INTERNAL_TOKEN_SCHEME]).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-internal-token',
    });
    const operation = document.paths['/v1/users/{id}/organizations']?.get;
    expect(operation?.security).toEqual([{ [INTERNAL_TOKEN_SCHEME]: [] }]);
    expect(operation?.description).toContain('procurement-service');
    // No other route of the controller is put under it, but fleet-service's
    // one-bit question (`live-membership.service-access.spec.ts`).
    for (const [route, item] of Object.entries(document.paths)) {
      if (route === '/v1/users/{id}/organizations') continue;
      if (route === '/v1/users/{id}/live-membership') continue;
      for (const [method, op] of Object.entries(item)) {
        const schemes = ((op as { security?: Record<string, unknown>[] }).security ?? []).flatMap(
          Object.keys,
        );
        expect({
          route: `${method} ${route}`,
          internal: schemes.includes(INTERNAL_TOKEN_SCHEME),
        }).toEqual({
          route: `${method} ${route}`,
          internal: false,
        });
      }
    }
  });
});
