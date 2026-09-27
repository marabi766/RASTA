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
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { InMemoryEventPublisher, KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { OrganizationService } from '../src/organization/organization.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, databaseUrl } from './helpers';

/**
 * The provider side of the one question construction-service asks this
 * service (Q-70 (7), decided 2026-09-26): is organization T the one my token
 * is signed for, or beneath it?
 *
 * Booted from the **real** `AppModule`, with the real auth guard and a real
 * HS256 internal token — the same token construction-service mints — so the
 * contract proven here is the one a deployment answers:
 *
 *   construction-service token signed for U, GET /v1/organizations/T
 *     T is U, or beneath U   → 200 { id: T }, and nothing else
 *     anything else          → 404
 *   any other calling service → 403 (no @AllowService)
 *
 * construction-service's consumer test (`organization-directory.int-spec.ts`)
 * holds its client to exactly these answers. Only the Kafka publisher and the
 * relay are replaced (outbox rows are still written); the user token verifier
 * is a claims stub, because only the unchanged person path uses it.
 */

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
  return new InternalTokenService(SECRET, 'rasta-internal', 300).issue(
    callerService,
    SERVICE_NAME,
    'SERVICE',
    organizationId,
  );
}

describe('GET /v1/organizations/:id for construction-service (Q-70 (7) contract)', () => {
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

  it('answers { id } — and nothing more — for a descendant two levels down', async () => {
    const token = await serviceToken('construction-service', union);
    const response = await http()
      .get(`/v1/organizations/${dehyari}`)
      .set('x-internal-token', token)
      .expect(200);
    expect(response.body).toEqual({ id: dehyari });
  });

  it('answers { id } for a direct child and for the signed organization itself', async () => {
    const token = await serviceToken('construction-service', union);
    for (const id of [county, union]) {
      const response = await http()
        .get(`/v1/organizations/${id}`)
        .set('x-internal-token', token)
        .expect(200);
      expect(response.body).toEqual({ id });
    }
  });

  it('answers 404 for an organization outside the signed subtree, and for one that does not exist', async () => {
    const token = await serviceToken('construction-service', union);
    for (const id of [stranger, 'ORG-DOES-NOT-EXIST']) {
      const response = await http()
        .get(`/v1/organizations/${id}`)
        .set('x-internal-token', token)
        .expect(404);
      expect(JSON.stringify(response.body)).not.toContain('آزمون');
    }
  });

  it('answers 404 upward: a descendant is never "within" its own descendant', async () => {
    const token = await serviceToken('construction-service', dehyari);
    await http().get(`/v1/organizations/${union}`).set('x-internal-token', token).expect(404);
  });

  it('refuses every other calling service (403): only construction-service may ask', async () => {
    const token = await serviceToken('marketplace-service', union);
    await http().get(`/v1/organizations/${dehyari}`).set('x-internal-token', token).expect(403);
  });

  it('refuses a service token on every other route (403)', async () => {
    const token = await serviceToken('construction-service', union);
    for (const path of [
      `/v1/organizations/${dehyari}/ancestors`,
      `/v1/organizations/${union}/children`,
      `/v1/organizations/${union}/subtree`,
      '/v1/organizations',
    ]) {
      await http().get(path).set('x-internal-token', token).expect(403);
    }
  });

  it('still gives a person the full record, unchanged', async () => {
    const response = await http()
      .get(`/v1/organizations/${dehyari}`)
      .set(
        'authorization',
        `Bearer ${bearer({ sub: 'sub-contract', organizationId: union, roles: ['SYSTEM_ADMIN'] })}`,
      )
      .expect(200);
    expect(response.body).toMatchObject({ id: dehyari, name: 'دهیاری آزمون' });
  });
});
