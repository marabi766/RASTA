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
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { InMemoryEventPublisher, KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { databaseUrl } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule` — the harness
 * supplier-service built, copied because services share no source (A-02).
 *
 * Three overrides, none a shortcut: the Kafka publisher (outbox rows are still
 * written in the real transaction), the relay (inert, so it does not drain rows
 * another suite asserts on), and the token verifier (reads a base64 claims
 * blob; signature checking is `@rasta/nest-common`'s and `tests/e2e`'s job).
 * Everything below the verifier is real: `resolveOrganization`,
 * `X-Organization-Id`, the guards, the tenant guard, the database.
 */

export interface ApiHarness {
  app: INestApplication;
  prisma: PrismaService;
  publisher: InMemoryEventPublisher;
  close(): Promise<void>;
}

export interface TestClaims {
  sub: string;
  rastaUserId?: string;
  /** The token's **active** organization — the one selected by default. */
  organizationId?: string;
  /** Every organization the token says this person belongs to. */
  organizationIds?: string[];
  roles: string[];
  username?: string;
}

/**
 * Encodes claims into the bearer token this harness's verifier understands.
 *
 * Not a JWT and deliberately not shaped like one: a value that looked like a
 * signed token would invite somebody to believe this suite verifies signatures.
 */
export function bearer(claims: TestClaims): string {
  return `test.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;
}

/** A user of one organization, with the roles given. */
export function actor(organizationId: string, roles: string[]): string {
  return bearer({
    sub: `sub-${ulid()}`,
    rastaUserId: `USR-APITEST-${ulid().slice(-8)}`,
    organizationId,
    organizationIds: [organizationId],
    roles,
    username: `api-test-${organizationId}`,
  });
}

/** A user who belongs to several organizations; `active` is the default tenant. */
export function multiMemberActor(active: string, memberships: string[], roles: string[]): string {
  return bearer({
    sub: `sub-${ulid()}`,
    rastaUserId: `USR-APITEST-${ulid().slice(-8)}`,
    organizationId: active,
    organizationIds: [active, ...memberships],
    roles,
    username: `api-test-multi-${active}`,
  });
}

/** The organization's administrator — the default project role (Q-69). */
export function orgAdmin(organizationId: string): string {
  return actor(organizationId, ['ORGANIZATION_ADMIN']);
}

/** A system administrator, whose token carries no active tenant. */
export function systemAdminWithoutTenant(): string {
  return bearer({
    sub: `sub-${ulid()}`,
    rastaUserId: `USR-APITEST-${ulid().slice(-8)}`,
    organizationIds: [],
    roles: ['SYSTEM_ADMIN'],
    username: 'api-test-system-admin',
  });
}

/** The province oversight role, which must reach nothing in this service. */
export function auditorActor(organizationId: string): string {
  return actor(organizationId, ['AUDITOR']);
}

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    // A `RastaError`, not a bare `Error`, because that is what the real
    // verifier does: `mapJoseError` turns every malformed or unverifiable token
    // into a 401. A bare throw here surfaces as a 500 and makes a test's own
    // mistake look like a service defect — which is exactly what happened the
    // first time this suite sent an internal token in the wrong header.
    throw RastaError.unauthenticated('Malformed token');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

/**
 * The shared secret for service-to-service tokens, minted per run.
 *
 * Generated rather than written down, and not because a literal here would be
 * dangerous — this value never leaves the process. Because a fixed string
 * assigned to something called `INTERNAL_SECRET` is indistinguishable from a
 * real one to a secret scanner, and a scanner taught to ignore this file has
 * been taught to ignore the next one too (AGENTS.md S-01).
 */
const INTERNAL_SECRET = randomBytes(24).toString('hex');

const SERVICE_NAME = 'construction-service';

export function internalToken(
  callerService: string,
  options: { purpose?: 'SERVICE' | 'RELAY'; organizationId?: string } = {},
): Promise<string> {
  return new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300).issue(
    callerService,
    SERVICE_NAME,
    options.purpose ?? 'SERVICE',
    options.organizationId,
  );
}

/**
 * The environment the booted application sees.
 *
 * Set on `process.env` rather than injected, because `AppModule` calls
 * `loadConstructionEnv()` in a factory — which is exactly the code path a
 * deployment uses, and worth exercising rather than bypassing.
 */
function applyEnvironment(): void {
  process.env.DATABASE_URL = databaseUrl();
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3110';
  process.env.OIDC_ISSUER_URL ??= 'http://apitest.invalid/realms/rasta';
  process.env.OIDC_JWKS_URI ??= 'http://apitest.invalid/realms/rasta/certs';
  process.env.OIDC_AUDIENCE ??= 'rasta-api';
  process.env.INTERNAL_TOKEN_SECRET = INTERNAL_SECRET;
  process.env.KAFKA_BROKERS ??= 'localhost:9092';
}

const inertRelay = { start: () => undefined, stop: async () => undefined };

export async function startApi(): Promise<ApiHarness> {
  applyEnvironment();

  const publisher = new InMemoryEventPublisher();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KafkaEventPublisher)
    .useValue(publisher)
    .overrideProvider(OutboxRelay)
    .useValue(inertRelay)
    .overrideProvider(AUTH_OPTIONS)
    .useFactory({
      factory: (): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        // Real, not stubbed. An internal token is an HS256 JWT signed with a
        // shared secret and scoped to one target service, so it can be minted
        // in-process without a network — which means the Zero Trust path
        // (ADR-020, ADR-035) is exercised for what it is rather than simulated.
        internalTokens: new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300),
        tokenVerifier: {
          verifyUserToken: async (token: string) => {
            const claims = decodeClaims(token);
            return {
              sub: claims.sub,
              rastaUserId: claims.rastaUserId,
              organizationId: claims.organizationId,
              ...projectedClaims(claims),
              roles: claims.roles,
              username: claims.username,
              expiresAt: Date.now() + 60_000,
            };
          },
          // The guard depends on the concrete TokenVerifier class and this stub
          // implements only the method it calls. The real class is exercised
          // by the guard's own suite and by tests/e2e.
        } as unknown as TokenVerifier,
      }),
    })
    .compile();

  const app = moduleRef.createNestApplication();
  // Same as main.ts: without it every `@Controller({ version: '1' })` route is
  // mounted at a path no client uses, and the whole suite would 404.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  return {
    app,
    prisma: moduleRef.get(PrismaService),
    publisher,
    close: async () => {
      await app.close();
    },
  };
}

/** A tenant identifier that cannot collide with another run's. */
export function apiTenant(label: string): string {
  return `ORG-APITEST-${label}-${ulid().slice(-10)}`;
}

/**
 * What the realm issues for a test actor since ADR-060: the active
 * organization among the memberships (the projector never writes one outside
 * them), and every role the actor holds, in each membership, as
 * `organization_roles` — the claim the guard reads roles from. As for the
 * seeded `system.admin`, `SYSTEM_ADMIN` is both a pair and a realm role.
 */
function projectedClaims(claims: {
  organizationId?: string;
  organizationIds?: string[];
  roles: string[];
}): { organizationIds: string[]; organizationRoles: string[] } {
  const organizationIds = [
    ...new Set(
      [claims.organizationId, ...(claims.organizationIds ?? [])].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
  const organizationRoles = organizationIds.flatMap((organizationId) =>
    claims.roles.map((role) => `${organizationId}:${role}`),
  );
  return { organizationIds, organizationRoles };
}
