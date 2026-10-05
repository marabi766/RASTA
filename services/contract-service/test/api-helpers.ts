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
import { TenderAwardedConsumer } from '../src/events/tender-awarded.consumer';
import { databaseUrl } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule` — the harness construction-service
 * built, copied because services share no source (A-02).
 *
 * Three overrides, none a shortcut: the Kafka publisher (outbox rows are still written in
 * the real transaction), the relay and the consumer (inert, so they do not touch a broker or
 * drain rows another suite asserts on — the consumer is proven in `tender-awarded.int-spec.ts`),
 * and the token verifier (reads a base64 claims blob; signature checking is `@rasta/nest-common`'s
 * and `tests/e2e`'s job). Everything below the verifier is real: `resolveOrganization`,
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
  /**
   * The verified issuer. Absent means the configured one (`OIDC_ISSUER_URL`), as the real
   * verifier accepts no other; a suite sets it only to model an identity that cannot be compared
   * with another's (#188).
   */
  iss?: string;
  organizationId?: string;
  organizationIds?: string[];
  roles: string[];
  username?: string;
}

/**
 * Encodes claims into the bearer token this harness's verifier understands. Not a JWT and
 * deliberately not shaped like one: a value that looked like a signed token would invite
 * somebody to believe this suite verifies signatures.
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

/**
 * A person with the identity the suite chooses, acting for `organizationId` with `roles` and a
 * member of every organization in `memberships` — for the separation-of-duties cases, where two
 * tokens must be one person (same `sub`) or one token a member of both parties.
 */
export function person(
  organizationId: string,
  roles: string[],
  options: {
    sub?: string;
    rastaUserId?: string | undefined;
    iss?: string;
    memberships?: string[];
  } = {},
): string {
  return bearer({
    sub: options.sub ?? `sub-${ulid()}`,
    ...('rastaUserId' in options
      ? options.rastaUserId === undefined
        ? {}
        : { rastaUserId: options.rastaUserId }
      : { rastaUserId: `USR-APITEST-${ulid().slice(-8)}` }),
    ...(options.iss === undefined ? {} : { iss: options.iss }),
    organizationId,
    organizationIds: [organizationId, ...(options.memberships ?? [])],
    roles,
    username: `api-test-${organizationId}`,
  });
}

/** The employer's reader: the default role set (`CONTRACT_READER_ROLES`). */
export const orgAdmin = (organizationId: string): string =>
  actor(organizationId, ['ORGANIZATION_ADMIN']);

/** The winning contractor, acting in its own organization. */
export const contractor = (organizationId: string): string => actor(organizationId, ['CONTRACTOR']);

/** The oversight role, which must reach nothing in this service. */
export const auditor = (organizationId: string): string => actor(organizationId, ['AUDITOR']);

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

/** A system administrator who belongs to the organization it will select. */
export const systemAdminOf = (organizationId: string): string =>
  actor(organizationId, ['SYSTEM_ADMIN']);

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    // A `RastaError`, as the real verifier throws: a bare `Error` would surface as a 500 and
    // make a test's own mistake look like a service defect.
    throw RastaError.unauthenticated('Malformed token');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

/**
 * The shared secret for service-to-service tokens, minted per run: never written down, so a
 * secret scanner has nothing here to learn to ignore (AGENTS.md S-01).
 */
const INTERNAL_SECRET = randomBytes(24).toString('hex');

const SERVICE_NAME = 'contract-service';

export function internalToken(
  callerService: string,
  options: { organizationId?: string } = {},
): Promise<string> {
  return new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300).issue(
    callerService,
    SERVICE_NAME,
    'SERVICE',
    options.organizationId,
  );
}

/**
 * Configuration the commands need and the service deliberately does not default (Q-95 (1)): the
 * employer's signing authority. A suite that tests its absence passes `''`.
 */
const DEFAULT_TEST_ENV: Record<string, string> = {
  CONTRACT_OWNER_SIGNER_ROLES: 'ORGANIZATION_ADMIN',
};

function applyEnvironment(overrides: Record<string, string>): () => void {
  const wanted = { ...DEFAULT_TEST_ENV, ...overrides };
  const before = new Map(Object.keys(wanted).map((name) => [name, process.env[name]]));
  Object.assign(process.env, wanted);
  process.env.DATABASE_URL = databaseUrl();
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3111';
  process.env.OIDC_ISSUER_URL ??= 'http://apitest.invalid/realms/rasta';
  process.env.OIDC_JWKS_URI ??= 'http://apitest.invalid/realms/rasta/certs';
  process.env.OIDC_AUDIENCE ??= 'rasta-api';
  process.env.INTERNAL_TOKEN_SECRET = INTERNAL_SECRET;
  process.env.KAFKA_BROKERS ??= 'localhost:9092';
  // Nothing built here reaches the broker, so the app may be built without this service's
  // credential: the explicit opt-out, honoured only under NODE_ENV test (RUN-006).
  process.env.KAFKA_ALLOW_PLAINTEXT ??= 'true';
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

const inert = { start: () => undefined, stop: async () => undefined };

export async function startApi(env: Record<string, string> = {}): Promise<ApiHarness> {
  const restoreEnvironment = applyEnvironment(env);

  const publisher = new InMemoryEventPublisher();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KafkaEventPublisher)
    .useValue(publisher)
    .overrideProvider(OutboxRelay)
    .useValue(inert)
    .overrideProvider(TenderAwardedConsumer)
    .useValue(inert)
    .overrideProvider(AUTH_OPTIONS)
    .useFactory({
      factory: (): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        // Real, not stubbed: an internal token is an HS256 JWT signed with a shared secret
        // and scoped to one target service, so the Zero Trust path (ADR-020, ADR-035) is
        // exercised for what it is.
        internalTokens: new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300),
        tokenVerifier: {
          verifyUserToken: async (token: string) => {
            const claims = decodeClaims(token);
            return {
              sub: claims.sub,
              rastaUserId: claims.rastaUserId,
              issuer: claims.iss ?? process.env.OIDC_ISSUER_URL,
              organizationId: claims.organizationId,
              ...projectedClaims(claims),
              roles: claims.roles,
              username: claims.username,
              expiresAt: Date.now() + 60_000,
            };
          },
          // The guard depends on the concrete TokenVerifier class and this stub implements
          // only the method it calls. The real class is exercised by the guard's own suite
          // and by tests/e2e.
        } as unknown as TokenVerifier,
      }),
    })
    .compile();

  const app = moduleRef.createNestApplication();
  // Same as main.ts: without it every `@Controller({ version: '1' })` route is mounted at a
  // path no client uses, and the whole suite would 404.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  return {
    app,
    prisma: moduleRef.get(PrismaService),
    publisher,
    close: async () => {
      await app.close();
      restoreEnvironment();
    },
  };
}

/**
 * What the realm issues for a test actor since ADR-060: the active organization among the
 * memberships, and every role the actor holds in each membership as `organization_roles` —
 * the claim the guard reads roles from.
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
