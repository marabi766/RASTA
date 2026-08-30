import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxRelay,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { InMemoryEventPublisher, KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { OrderSagaWorker } from '../src/temporal/worker';
import { OrderSagaClient } from '../src/temporal/saga.client';
import { databaseUrl } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule`.
 *
 * `docs/14` § 14.5 makes an API test mandatory for every public endpoint
 * including its error paths. Until this file there was none for this service:
 * both controllers, every view mapper and the composition root sat at zero
 * coverage, and the paths that turn a domain error into a status code — the
 * difference between a 404 and a 403 on a cross-tenant read — were asserted
 * only end to end, where a failure names the whole stack rather than the line.
 *
 * ## Booted from `AppModule`, not from a hand-built module
 *
 * The composition root is part of what is under test. A hand-assembled module
 * proves the objects work together when a test wires them; it says nothing
 * about whether the service wires them the same way. The guards, the exception
 * filter, the context middleware and URI versioning all come from the real
 * graph here.
 *
 * ## The four overrides, and why none is a shortcut
 *
 * **Kafka publisher.** Replaced with `InMemoryEventPublisher`, which the
 * service already ships. The outbox row is still written to the real database
 * inside the real transaction — the property that matters, and the one
 * `idempotency-outbox.int-spec.ts` proves. What is skipped is the relay's
 * network hop, which no controller assertion depends on.
 *
 * **The outbox relay.** Inert, and that is a correctness fix rather than a
 * speed one: it polls **every** pending row in the database, so while one of
 * these applications is alive it drains rows other suites in the same run
 * wrote and are about to assert are still pending. economic-service hit
 * exactly that under `--coverage`.
 *
 * **The Temporal worker.** Inert. It would otherwise dial a Temporal server on
 * bootstrap, and what these tests exercise is the HTTP layer. The workflow it
 * runs has its own suite against a real time-skipping Temporal server.
 *
 * **The token verifier.** Replaced with one that reads a base64 claims blob.
 * The one place in this service's tests where a signature is not checked, and
 * deliberate: RS256 pinning, `aud`/`iss`/`exp` and the JWKS cache are covered
 * by `auth.guard.spec.ts`, and a *real* Keycloak token is what `tests/e2e`
 * uses. What this file exercises is what happens **after** a caller is
 * authenticated — which role reaches which endpoint, which record they may
 * touch, and which status a refusal carries.
 *
 * The saga client is **not** overridden. It is real, with Temporal disabled,
 * so the controller's `saga.start()` and `saga.signal()` calls run the
 * disabled path they take on a machine with no Temporal — and the enabled path
 * is covered by `saga.client.spec.ts`.
 *
 * Everything else is real: the database, the constraints, the row locks, the
 * partial unique index, the state machine and the pricing.
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
  organizationId?: string;
  organizationIds?: string[];
  roles: string[];
  username?: string;
}

/**
 * Encodes claims into the bearer token this harness's verifier understands.
 *
 * Not a JWT and deliberately not shaped like one: a value that looked like a
 * signed token would invite somebody to believe this suite verifies
 * signatures.
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

/** A buyer — the role that may commit an organization to a purchase. */
export function buyer(organizationId: string): string {
  return actor(organizationId, ['PROCUREMENT_USER']);
}

/** A supplier — the role that publishes offers and records fulfilment. */
export function supplier(organizationId: string): string {
  return actor(organizationId, ['SUPPLIER']);
}

/** A platform operator — the only role that may resolve a dispute. */
export function platformAdmin(organizationId = 'ORG-APITEST-PLATFORM'): string {
  return actor(organizationId, ['UNION_ADMIN']);
}

/** The province oversight role, which must reach nothing in this service. */
export function auditor(organizationId: string): string {
  return actor(organizationId, ['AUDITOR']);
}

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    throw new Error('This harness only accepts tokens minted by `bearer()`');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

/**
 * The shared secret for service-to-service tokens, minted per run.
 *
 * Generated rather than written down, and not because a literal here would be
 * dangerous — this value never leaves the process. Because a 32-character
 * string assigned to something called `INTERNAL_SECRET` is indistinguishable
 * from a real one to a secret scanner, and a scanner taught to ignore this
 * file has been taught to ignore the next one too (AGENTS.md S-01).
 */
const INTERNAL_SECRET = randomBytes(24).toString('hex');

const SERVICE_NAME = 'marketplace-service';

export interface InternalTokenOptions {
  purpose?: 'SERVICE' | 'RELAY';
  /** Who the token is minted **for**. Naming another service is how the audience check is reached. */
  targetService?: string;
  /** The organization this token may act for, signed into it (ADR-035). */
  organizationId?: string;
  ttlSeconds?: number;
}

export function internalToken(
  callerService: string,
  options: InternalTokenOptions = {},
): Promise<string> {
  const ttl = options.ttlSeconds ?? 300;
  return new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', ttl).issue(
    callerService,
    options.targetService ?? SERVICE_NAME,
    options.purpose ?? 'SERVICE',
    options.organizationId,
  );
}

/**
 * The environment the booted application sees.
 *
 * Set on `process.env` rather than injected, because `AppModule` calls
 * `loadMarketplaceEnv()` in a factory — which is exactly the code path a
 * deployment uses, and worth exercising rather than bypassing.
 */
function applyEnvironment(): void {
  process.env.DATABASE_URL = databaseUrl();
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3106';
  process.env.OIDC_ISSUER_URL ??= 'http://apitest.invalid/realms/rasta';
  process.env.OIDC_JWKS_URI ??= 'http://apitest.invalid/realms/rasta/certs';
  process.env.OIDC_AUDIENCE ??= 'rasta-api';
  process.env.INTERNAL_TOKEN_SECRET = INTERNAL_SECRET;
  process.env.KAFKA_BROKERS ??= 'localhost:9092';
  // No Temporal server in this suite. The saga client is real and takes its
  // disabled path, which is the path a developer without Temporal gets.
  process.env.MARKETPLACE_TEMPORAL_ENABLED = 'false';
}

const inertRelay = { start: () => undefined, stop: async () => undefined };
const inertWorker = {
  onApplicationBootstrap: async () => undefined,
  onModuleDestroy: async () => undefined,
};

export async function startApi(): Promise<ApiHarness> {
  applyEnvironment();

  const publisher = new InMemoryEventPublisher();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KafkaEventPublisher)
    .useValue(publisher)
    .overrideProvider(OutboxRelay)
    .useValue(inertRelay)
    .overrideProvider(OrderSagaWorker)
    .useValue(inertWorker)
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
          // class is exercised by auth.guard.spec.ts and by tests/e2e.
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

/** The real saga client the booted application holds, for assertions on it. */
export function sagaClientOf(harness: ApiHarness): OrderSagaClient {
  return harness.app.get(OrderSagaClient);
}

/** A tenant identifier that cannot collide with another run's. */
export function apiTenant(label: string): string {
  return `ORG-APITEST-${label}-${ulid().slice(-10)}`;
}

/** A unique `Idempotency-Key` per call site. */
export function apiKey(prefix: string): string {
  return `${prefix}-${ulid()}`;
}
