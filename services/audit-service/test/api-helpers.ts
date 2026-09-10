import { randomBytes } from 'node:crypto';
import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  RastaError,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { DomainProjectorConsumer } from '../src/consumers/domain-projector.consumer';
import { PrismaService } from '../src/prisma/prisma.service';
import { runtimeUrl } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule`.
 *
 * ## Booted from the composition root, not from a hand-built module
 *
 * The wiring is part of what is under test. A hand-assembled module proves the
 * objects work together when a test wires them and says nothing about whether
 * the service wires them the same way. The global `AuthGuard`, the global
 * `RolesGuard`, the exception filter, the context middleware, URI versioning
 * and the query pipes built from the validated environment all come from the
 * real graph here — which is what makes "no `POST /v1/audit-events` route
 * exists" a fact about the service rather than about this file.
 *
 * ## Two overrides, and why neither is a shortcut
 *
 * **The projector.** Replaced with an inert object. A real one subscribes to
 * ten topics and replays each from the beginning, which needs a broker these
 * suites do not; its behaviour is covered against a real broker by
 * `kafka-projector.int-spec.ts` and branch by branch by its unit spec. Nothing
 * asserted here depends on it: rows are seeded through the database, which is
 * real.
 *
 * **The token verifier.** Replaced with one that reads a base64 claims blob.
 * This is the one place in these suites where a signature is not checked, and
 * it is deliberate: RS256 pinning, `aud`/`iss`/`exp` and the JWKS cache are
 * covered by `auth.guard.spec.ts` in `@rasta/nest-common`, and a real Keycloak
 * token is what `tests/e2e` uses. What this file exercises is what happens
 * **after** a caller is authenticated — which role reaches which endpoint,
 * which record they may read, and which status a refusal carries.
 *
 * The internal token service is **not** stubbed. An internal token is an HS256
 * JWT signed with a shared secret and scoped to one target service, so it can
 * be minted in-process without a network — which means "a valid service token
 * is still refused" can be proved for what it actually is rather than
 * simulated.
 *
 * Everything else is real: the database, the append-only privileges, the
 * triggers, the partitions, the recursive subtree walk.
 */

export const SERVICE_NAME = 'audit-service';

/**
 * The shared secret for service-to-service tokens, minted per run.
 *
 * Generated rather than written down, and not because a literal here would be
 * dangerous — this value never leaves the process. Because a 32-character
 * string assigned to something called `INTERNAL_SECRET` is indistinguishable
 * from a real one to a secret scanner, and a scanner taught to ignore this file
 * has been taught to ignore the next one (AGENTS.md S-01).
 */
const INTERNAL_SECRET = randomBytes(24).toString('hex');

export interface TestClaims {
  sub: string;
  rastaUserId?: string;
  organizationId?: string;
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

function user(organizationId: string | undefined, roles: string[]): string {
  return bearer({
    sub: `sub-${ulid()}`,
    rastaUserId: `USR-AUDITTEST-${ulid().slice(-8)}`,
    organizationId,
    organizationIds: organizationId ? [organizationId] : [],
    roles,
    username: 'audit-api-test',
  });
}

/** Platform authority: every tenant, and the platform-scoped rows as well. */
export const systemAdmin = (organizationId?: string): string =>
  user(organizationId, ['SYSTEM_ADMIN']);

/** Subtree authority, rooted at the organization the token names. */
export const unionAdmin = (organizationId: string): string => user(organizationId, ['UNION_ADMIN']);

/** The province oversight role, which must reach nothing in this service. */
export const auditor = (organizationId: string): string => user(organizationId, ['AUDITOR']);

/** Least privilege while "owner of the record" is ambiguous (ADR-053 § 11). */
export const organizationAdmin = (organizationId: string): string =>
  user(organizationId, ['ORGANIZATION_ADMIN']);

/** A role no audit rule mentions — closed by default (AGENTS.md S-02). */
export const unlistedRole = (organizationId: string): string =>
  user(organizationId, ['FLEET_MANAGER']);

/**
 * A service-to-service token, as another service would mint one.
 *
 * `purpose: 'SERVICE'` says "another service is calling on its own behalf",
 * which is exactly the caller ADR-053 § 10 refuses: nothing in MVP reads audit
 * programmatically.
 */
export function internalToken(
  callerService = 'economic-service',
  purpose: 'SERVICE' | 'RELAY' = 'SERVICE',
): Promise<string> {
  return new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300).issue(
    callerService,
    SERVICE_NAME,
    purpose,
  );
}

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    // The refusal a real JWKS verifier gives, not a bare `Error`. A bare
    // `Error` leaves the exception filter with nothing to map and every
    // unparseable credential arrives at the assertion as a 500, which would
    // hide the 401 the service actually returns — the harness would be
    // reporting its own stub instead of the product.
    throw RastaError.unauthenticated('Token is not verifiable');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

/**
 * The environment the booted application sees.
 *
 * Set on `process.env` rather than injected, because `AppModule` calls
 * `loadAuditEnv()` in a factory — the same code path a deployment uses, and
 * worth exercising rather than bypassing.
 */
function applyEnvironment(maxQueryWindowDays?: number): void {
  process.env.DATABASE_URL = runtimeUrl();
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3115';
  process.env.KAFKA_BROKERS ??= 'localhost:9092';
  process.env.OIDC_ISSUER_URL ??= 'http://audittest.invalid/realms/rasta';
  process.env.OIDC_JWKS_URI ??= 'http://audittest.invalid/realms/rasta/certs';
  process.env.OIDC_AUDIENCE ??= 'rasta-api';
  process.env.INTERNAL_TOKEN_SECRET = INTERNAL_SECRET;
  if (maxQueryWindowDays === undefined) {
    delete process.env.AUDIT_MAX_QUERY_WINDOW_DAYS;
  } else {
    process.env.AUDIT_MAX_QUERY_WINDOW_DAYS = String(maxQueryWindowDays);
  }
}

/** A projector that connects to nothing. See the note on the overrides above. */
const inertProjector = {
  start: async (): Promise<void> => undefined,
  onModuleDestroy: async (): Promise<void> => undefined,
  isRunning: (): boolean => false,
};

export interface ApiHarness {
  app: INestApplication;
  prisma: PrismaService;
  close(): Promise<void>;
}

export interface StartApiOptions {
  /** Overrides `AUDIT_MAX_QUERY_WINDOW_DAYS`, to prove the 400 names it. */
  maxQueryWindowDays?: number;
}

export async function startApi(options: StartApiOptions = {}): Promise<ApiHarness> {
  applyEnvironment(options.maxQueryWindowDays);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DomainProjectorConsumer)
    .useValue(inertProjector)
    .overrideProvider(AUTH_OPTIONS)
    .useFactory({
      factory: (): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
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
          // class is exercised by `auth.guard.spec.ts` and by `tests/e2e`.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    })
    .compile();

  const app = moduleRef.createNestApplication();
  // Same as `main.ts`: without it every `@Controller({ version: '1' })` route
  // is mounted at a path no client uses and the whole suite would 404 for the
  // wrong reason.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  return {
    app,
    prisma: moduleRef.get(PrismaService),
    close: async () => {
      await app.close();
    },
  };
}
