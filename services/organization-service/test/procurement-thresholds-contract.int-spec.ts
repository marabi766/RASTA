import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxRelay,
  RastaError,
  type AuthGuardOptions,
  type TokenVerifier,
} from '@rasta/nest-common';
import { mintTestInternalToken } from '@rasta/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { InMemoryEventPublisher, KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { OrganizationService } from '../src/organization/organization.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, databaseUrl } from './helpers';

/** Provider contract: real AppModule, existing guards and signed service tokens. */
const SECRET = randomBytes(24).toString('hex');
const SERVICE_NAME = 'organization-service';

const inertRelay = { start: () => undefined, stop: async () => undefined };

interface TestClaims {
  sub: string;
  organizationId: string;
  roles: string[];
}

const bearer = (claims: TestClaims) =>
  `test.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;

function serviceToken(callerService: string, organizationId: string): Promise<string> {
  return mintTestInternalToken(
    { secret: SECRET, issuer: 'rasta-internal', ttlSeconds: 300 },
    callerService,
    SERVICE_NAME,
    'SERVICE',
    organizationId,
  );
}

describe('GET /v1/organizations/:id/procurement-thresholds provider contract', () => {
  let app: INestApplication;
  let union: string;
  let county: string;
  let dehyari: string;
  let stranger: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl();
    process.env.OIDC_ISSUER_URL ??= 'http://contract.invalid/realms/rasta';
    process.env.OIDC_JWKS_URI ??= 'http://contract.invalid/realms/rasta/certs';
    process.env.OIDC_AUDIENCE ??= 'rasta-api';
    process.env.INTERNAL_TOKEN_SECRET = SECRET;
    process.env.KAFKA_BROKERS ??= 'localhost:9092';
    // Nothing built here reaches the broker (the relay and consumers are
    // inert), so the app may be built without this service's broker
    // credential: the explicit opt-out, honoured only under NODE_ENV test
    // (RUN-006). A suite that does reach the broker authenticates.
    process.env.KAFKA_ALLOW_PLAINTEXT ??= 'true';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KafkaEventPublisher)
      .useValue(new InMemoryEventPublisher())
      .overrideProvider(OutboxRelay)
      .useValue(inertRelay)
      .overrideProvider(AUTH_OPTIONS)
      .useFactory({
        factory: (): AuthGuardOptions => ({
          serviceName: SERVICE_NAME,
          internalTokens: new InternalTokenService(SECRET, 'rasta-internal', 300),
          tokenVerifier: {
            verifyUserToken: async (token: string) => {
              const [prefix, encoded] = token.split('.');
              if (prefix !== 'test' || !encoded) throw RastaError.unauthenticated('Malformed');
              const claims = JSON.parse(
                Buffer.from(encoded, 'base64url').toString('utf8'),
              ) as TestClaims;
              return {
                sub: claims.sub,
                rastaUserId: `USR-CONTRACT-${ulid().slice(-8)}`,
                organizationId: claims.organizationId,
                organizationIds: [claims.organizationId],
                organizationRoles: claims.roles.map((role) => `${claims.organizationId}:${role}`),
                roles: claims.roles,
                username: 'contract-test',
                expiresAt: Date.now() + 60_000,
              };
            },
          } as unknown as TokenVerifier,
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();

    // union → county → dehyari, and an unrelated root.
    const organizations = moduleRef.get(OrganizationService);
    const create = (name: string, type: string, parentId?: string) =>
      asActor({ organizationId: 'ORG-CONTRACT-OPERATOR', roles: ['SYSTEM_ADMIN'] }, () =>
        organizations.create({
          name,
          type,
          metadata: {},
          ...(parentId ? { parentId } : {}),
        } as never),
      );
    union = (await create(`اتحادیه آزمون ${ulid().slice(-6)}`, 'UNION')).id;
    county = (await create('شهرستان آزمون', 'GOVERNMENT', union)).id;
    dehyari = (await create('دهیاری آزمون', 'DEHYARI', county)).id;
    stranger = (await create('سازمان بیرونی', 'COMPANY')).id;
  });

  afterAll(async () => {
    const prisma = app?.get(PrismaService);
    if (prisma && union) {
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM organization WHERE id IN ($1, $2, $3, $4)`,
        dehyari,
        county,
        union,
        stranger,
      );
    }
    await app?.close();
  });

  const key = 'construction.tender.procurement_thresholds';
  const range = { minAmountMinor: '0', maxAmountMinor: '1000000', mode: 'WARN' };
  const value = { FORMAL_TENDER: range, INQUIRY: range, RFP: range, MARKETPLACE_DEAL: range };
  // Consumer wire shape, independently stated here: no cross-service implementation import.
  const entrySchema = z
    .object({
      minAmountMinor: z.string().regex(/^\d+$/).nullable(),
      maxAmountMinor: z.string().regex(/^\d+$/).nullable(),
      mode: z.enum(['WARN', 'REJECT']),
    })
    .strict();
  const responseSchema = z
    .object({
      organizationId: z.string(),
      policy: z
        .object({
          id: z.string().min(1),
          value: z
            .object({
              FORMAL_TENDER: entrySchema,
              INQUIRY: entrySchema,
              RFP: entrySchema,
              MARKETPLACE_DEAL: entrySchema,
            })
            .strict(),
        })
        .strict()
        .nullable(),
    })
    .strict();
  const read = async (target: string, signedFor = target, caller = 'construction-service') =>
    http()
      .get(`/v1/organizations/${target}/procurement-thresholds`)
      .set('x-internal-token', await serviceToken(caller, signedFor));
  const set = (organizationId: string, policyKey = key, inheritable = true) =>
    asActor({ organizationId: union, roles: ['SYSTEM_ADMIN'] }, () =>
      app.get(OrganizationService).setPolicy(organizationId, {
        key: policyKey,
        value,
        inheritable,
        description: 'Test procurement policy',
      }),
    );

  beforeEach(async () => {
    await app.get(PrismaService).client.organizationPolicy.deleteMany({
      where: { organizationId: { in: [union, county, dehyari, stranger] } },
    });
  });

  it.each([
    null,
    {},
    { ...value, INQUIRY: { ...range, mode: 'ALLOW' } },
    { ...value, INQUIRY: { ...range, minAmountMinor: 1 } },
    { ...value, INQUIRY: { ...range, minAmountMinor: '1000001' } },
    { ...value, INQUIRY: { ...range, maxAmountMinor: '9223372036854775808' } },
    { ...value, extra: range },
  ])('refuses malformed threshold policy %j before replacing any row', async (bad) => {
    const original = await set(dehyari);
    await expect(
      asActor({ organizationId: union, roles: ['SYSTEM_ADMIN'] }, () =>
        app
          .get(OrganizationService)
          .setPolicy(dehyari, { key, value: bad, inheritable: true, description: 'Invalid table' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await read(dehyari)).body.policy).toEqual({ id: original.id, value });
    expect(
      await app
        .get(PrismaService)
        .client.organizationPolicy.count({ where: { organizationId: dehyari, key } }),
    ).toBe(1);
  });

  const writeHttp = (policyKey: string, policyValue: unknown) =>
    http()
      .post(`/v1/organizations/${dehyari}/policies`)
      .set(
        'authorization',
        `Bearer ${bearer({ sub: 'policy-setter', organizationId: dehyari, roles: ['SYSTEM_ADMIN'] })}`,
      )
      .send({
        key: policyKey,
        value: policyValue,
        inheritable: true,
        description: 'HTTP policy test',
      });

  it('returns HTTP 400 VALIDATION_FAILED for a malformed table without writing a row', async () => {
    const response = await writeHttp(key, { ...value, INQUIRY: { ...range, mode: 'ALLOW' } });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ path: 'value', code: 'INVALID_PROCUREMENT_THRESHOLDS' })],
    });
    expect(
      await app.get(PrismaService).client.organizationPolicy.count({
        where: { organizationId: dehyari },
      }),
    ).toBe(0);
  });

  it('accepts a non-table value over HTTP for another key', async () => {
    const otherKey = 'private.other_policy';
    const otherValue = { arbitrary: 'not a threshold table' };
    const response = await writeHttp(otherKey, otherValue);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ key: otherKey, value: otherValue });
    expect(
      await app.get(PrismaService).client.organizationPolicy.findMany({
        where: { organizationId: dehyari },
      }),
    ).toEqual([expect.objectContaining({ key: otherKey, value: otherValue })]);
  });

  it('returns the own value ahead of the inherited value, with the consumer shape', async () => {
    await set(union);
    const own = await set(dehyari);
    const response = await read(dehyari);
    expect(response.status).toBe(200);
    expect(responseSchema.parse(response.body)).toEqual({
      organizationId: dehyari,
      policy: { id: own.id, value },
    });
  });
  it('resolves the nearest inheritable ancestor, with the consumer shape', async () => {
    await set(union);
    const nearest = await set(county);
    const response = await read(dehyari);
    expect(response.status).toBe(200);
    expect(responseSchema.parse(response.body)).toEqual({
      organizationId: dehyari,
      policy: { id: nearest.id, value },
    });
  });
  it('returns explicit null when the key is absent, with the consumer shape', async () => {
    const response = await read(dehyari);
    expect(response.status).toBe(200);
    expect(responseSchema.parse(response.body)).toEqual({ organizationId: dehyari, policy: null });
  });
  it('does not inherit a non-inheritable ancestor value', async () => {
    await set(union, key, false);
    const response = await read(dehyari);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ organizationId: dehyari, policy: null });
  });
  it('contains no other policy keys or policy metadata', async () => {
    await set(union, 'private.other_policy');
    const own = await set(dehyari);
    const response = await read(dehyari);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ organizationId: dehyari, policy: { id: own.id, value } });
    expect(JSON.stringify(response.body)).not.toContain('private.other_policy');
  });
  it.each(['contract-service', 'economic-service', 'marketplace-service', 'fleet-service'])(
    'refuses %s through the existing guard',
    async (caller) => {
      expect((await read(dehyari, dehyari, caller)).status).toBe(403);
    },
  );
  it.each(['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'])(
    'refuses a person/session token even with %s',
    async (role) => {
      await http()
        .get(`/v1/organizations/${dehyari}/procurement-thresholds`)
        .set(
          'authorization',
          `Bearer ${bearer({ sub: 'person', organizationId: dehyari, roles: [role] })}`,
        )
        .expect(403);
    },
  );
  it('refuses a forwarded person token from construction-service', async () => {
    const token = await mintTestInternalToken(
      { secret: SECRET, issuer: 'rasta-internal', ttlSeconds: 300 },
      'construction-service',
      SERVICE_NAME,
      'RELAY',
    );
    await http()
      .get(`/v1/organizations/${dehyari}/procurement-thresholds`)
      .set('x-internal-token', token)
      .set(
        'authorization',
        `Bearer ${bearer({ sub: 'person', organizationId: dehyari, roles: ['SYSTEM_ADMIN'] })}`,
      )
      .expect(403);
  });
  it('returns identical generic 404s for mismatched descendant, stranger and missing ids', async () => {
    const responses = await Promise.all(
      [dehyari, stranger, 'ORG-DOES-NOT-EXIST'].map((id) => read(id, union)),
    );
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND', message: 'Organization not found' });
      expect(response.body.details).toBeUndefined();
      expect(Object.keys(response.body).sort()).toEqual(
        ['code', 'message', 'correlationId', 'timestamp', 'path'].sort(),
      );
    }
  });
  it('does not treat a signed but nonexistent organization as an absent table', async () => {
    expect((await read('ORG-DOES-NOT-EXIST')).status).toBe(404);
  });
});
