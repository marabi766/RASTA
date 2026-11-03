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
  getContext,
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
 * `GET /v1/users/:id/live-membership` over HTTP, for its one caller (task 095):
 * fleet-service with a token signed **for a tenant** (ADR-035), asking whether a user is a
 * live member of that tenant before registering them as a driver. Everybody else is
 * refused: a person with any role, any other service (the two that read the full
 * memberships included), a tenant-less fleet token, a relay.
 *
 * The real controller behind the real `AuthGuard` and `RolesGuard`, and the real
 * `IdentityService` over a repository that records what it was asked. `@AllowService`
 * refuses another service before the handler runs; the service's own caller check
 * refuses a tenant-less token the guard lets through. The repository is never asked for a
 * refused call, and the answer is one bit: no roles, no other organization, no name.
 */

const SECRET = randomBytes(24).toString('hex');
const ISSUER = 'rasta-internal';
const ORG_A = 'ORG_A';
const DB_NOW = new Date('2026-10-17T10:00:00.000Z');

const asked: { userId: string; organizationId: string | undefined }[] = [];
let liveAnswer = true;

const repository = {
  findLiveMembershipInScope: async (userId: string) => {
    // What the tenant guard would scope the query to: the request's organization.
    asked.push({ userId, organizationId: getContext().organizationId });
    return { live: liveAnswer, asOf: DB_NOW };
  },
  findLiveMemberships: async () => {
    throw new Error('fleet-service must never reach the full membership read');
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

describe('GET /v1/users/:id/live-membership service access (task 095)', () => {
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
    liveAnswer = true;
  });

  const path = '/v1/users/USR_1/live-membership';
  const service = (caller: string, organizationId?: string, audience = 'identity-service') =>
    mintTestInternalToken(tokenKey, caller, audience, 'SERVICE', organizationId);
  const ask = async (token: string, target = path) =>
    request(app.getHttpServer()).get(target).set('x-internal-token', token);

  it('answers fleet-service with a token signed for a tenant: one bit about that tenant, nothing else', async () => {
    const yes = await ask(await service('fleet-service', ORG_A));
    expect(yes.status).toBe(200);
    expect(yes.body).toEqual({
      userId: 'USR_1',
      organizationId: ORG_A,
      live: true,
      asOf: DB_NOW.toISOString(),
    });

    liveAnswer = false;
    const no = await ask(await service('fleet-service', 'ORG_B'));
    expect(no.status).toBe(200);
    expect(no.body).toEqual({
      userId: 'USR_1',
      organizationId: 'ORG_B',
      live: false,
      asOf: DB_NOW.toISOString(),
    });
    // Asked for the signed organization each time — never a parameter.
    expect(asked).toEqual([
      { userId: 'USR_1', organizationId: ORG_A },
      { userId: 'USR_1', organizationId: 'ORG_B' },
    ]);
  });

  it('takes no organization from the request: an X-Organization-Id that disagrees with the token is refused', async () => {
    const response = await request(app.getHttpServer())
      .get(path)
      .set('x-internal-token', await service('fleet-service', ORG_A))
      .set('x-organization-id', 'ORG_B');
    expect(response.status).toBe(403);
    expect(asked).toHaveLength(0);
  });

  it('refuses fleet-service with a tenant-less token: 403, and reads nothing', async () => {
    const response = await ask(await service('fleet-service'));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect(asked).toHaveLength(0);
  });

  it('refuses every other service, tenant-less or not — the full-membership readers too: 403, and reads nothing', async () => {
    for (const caller of [
      'construction-service',
      'procurement-service',
      'notification-service',
      'asset-service',
      'api-gateway',
      'fleet-service-2',
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
      ['FLEET_MANAGER'],
      ['AUDITOR'],
    ]) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('authorization', `Bearer ${userToken(roles[0]!.toLowerCase(), roles)}`);
      expect({ roles, status: response.status }).toEqual({ roles, status: 403 });
    }
    const relayed = await request(app.getHttpServer())
      .get(path)
      .set(
        'x-internal-token',
        await mintTestInternalToken(tokenKey, 'api-gateway', 'identity-service', 'RELAY'),
      )
      .set('authorization', `Bearer ${userToken('relayed', ['FLEET_MANAGER'])}`);
    expect(relayed.status).toBe(403);
    expect(asked).toHaveLength(0);
  });

  it('refuses no token, a relay token alone, and a fleet-service token minted for another service: 401', async () => {
    expect((await request(app.getHttpServer()).get(path)).status).toBe(401);
    expect(
      (await ask(await mintTestInternalToken(tokenKey, 'api-gateway', 'identity-service', 'RELAY')))
        .status,
    ).toBe(401);
    expect((await ask(await service('fleet-service', ORG_A, 'asset-service'))).status).toBe(401);
    expect(asked).toHaveLength(0);
  });

  it('does not open the full membership read to fleet-service', async () => {
    for (const organizationId of [undefined, ORG_A]) {
      const response = await ask(
        await service('fleet-service', organizationId),
        '/v1/users/USR_1/organizations',
      );
      expect({ organizationId, status: response.status }).toEqual({ organizationId, status: 403 });
    }
  });

  it('is documented under the internal service token (X-Internal-Token), not the bearer', () => {
    const document = SwaggerModule.createDocument(app, identityDocumentConfig('test'));
    const operation = document.paths['/v1/users/{id}/live-membership']?.get;
    expect(operation?.security).toEqual([{ [INTERNAL_TOKEN_SCHEME]: [] }]);
    expect(operation?.description).toContain('fleet-service');
  });
});
