import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxRelay,
  RastaError,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { InMemoryEventPublisher, KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { databaseUrl } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule`.
 *
 * `docs/14` § 14.5 makes an API test mandatory for every public endpoint
 * including its error paths, and until this file there was none: the
 * controller, every view mapper and the composition root sat at zero coverage,
 * and the paths that turn a domain error into a status code — the difference
 * between a 404 and a 403 on a cross-tenant read — were asserted nowhere.
 *
 * ## Booted from `AppModule`, not from a hand-built module
 *
 * The composition root is part of what is under test. A hand-assembled module
 * proves the objects work together when a test wires them; it says nothing
 * about whether the service wires them the same way. The guards, the exception
 * filter, the context middleware and URI versioning all come from the real
 * graph here — which is also why this harness can reproduce D-2 at all: the
 * bypass lived in how the guard turned token claims into a `RequestContext`,
 * and a hand-built module would have skipped exactly that step.
 *
 * ## The three overrides, and why none is a shortcut
 *
 * **Kafka publisher.** Replaced with `InMemoryEventPublisher`, which the
 * service already ships. The outbox row is still written to the real database
 * inside the real transaction — the property that matters, and the one
 * `outbox.int-spec.ts` proves. What is skipped is the relay's network hop, on
 * which no controller assertion depends.
 *
 * **The outbox relay.** Inert, and that is a correctness fix rather than a
 * speed one: it polls every pending row in the database, so while one of these
 * applications is alive it drains rows other suites in the same run wrote and
 * are about to assert are still pending.
 *
 * **The token verifier.** Replaced with one that reads a base64 claims blob.
 * The one place in this service's tests where a signature is not checked, and
 * deliberate: RS256 pinning, `aud`/`iss`/`exp` and the JWKS cache belong to
 * `@rasta/nest-common`'s own guard suite, and a real Keycloak token is what
 * `tests/e2e` uses. What this file exercises is what happens **after** a caller
 * is authenticated — which role reaches which endpoint, which record they may
 * touch, which organization the request acts for, and which status a refusal
 * carries.
 *
 * Everything below the verifier is real: `resolveOrganization`, the
 * `X-Organization-Id` header, the membership set, the tenant guard, the
 * database, its constraints and its row locks.
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

/**
 * A user who belongs to **several** organizations.
 *
 * The shape D-2 is about. `active` is the tenant the request acts for unless
 * `X-Organization-Id` says otherwise; `memberships` is everything the token
 * says they belong to, which is what the platform must consider before letting
 * them decide anybody's case.
 */
export function multiMemberActor(
  active: string,
  memberships: string[],
  roles: string[],
): string {
  return bearer({
    sub: `sub-${ulid()}`,
    rastaUserId: `USR-APITEST-${ulid().slice(-8)}`,
    organizationId: active,
    organizationIds: [active, ...memberships],
    roles,
    username: `api-test-multi-${active}`,
  });
}

/** A supplier-side actor — registers and maintains its own profile. */
export function supplierActor(organizationId: string): string {
  return actor(organizationId, ['SUPPLIER']);
}

/** A platform operator — the only side that decides a qualification. */
export function platformAdmin(organizationId = `ORG-APITEST-PLATFORM-${ulid().slice(-8)}`): string {
  return actor(organizationId, ['UNION_ADMIN']);
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

/** A buyer-side reader of the directory. */
export function procurementUser(organizationId: string): string {
  return actor(organizationId, ['PROCUREMENT_USER']);
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

const SERVICE_NAME = 'supplier-service';

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
 * `loadSupplierEnv()` in a factory — which is exactly the code path a
 * deployment uses, and worth exercising rather than bypassing.
 */
function applyEnvironment(): void {
  process.env.DATABASE_URL = databaseUrl();
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3108';
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
              organizationIds: claims.organizationIds ?? [],
              roles: claims.roles,
              username: claims.username,
              expiresAt: Date.now() + 60_000,
            };
          },
          // JUSTIFIED-ANY: the guard depends on the concrete TokenVerifier
          // class and this stub implements only the method it calls. The real
          // class is exercised by the guard's own suite and by tests/e2e.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
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
