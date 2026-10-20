import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxPurgeScheduler,
  OutboxRelay,
  RastaError,
  type AuthGuardOptions,
  type TokenVerifier,
} from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { PrismaService, type ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { InMemoryEventPublisher, KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { DatabaseClock } from '../src/shared/clock';
import {
  AggregationWindowSweeper,
  type AggregationWindowSweeperOptions,
} from '../src/demand/aggregation-window.sweeper';
import { WindowSweepRepository } from '../src/demand/window-sweep.repository';
import { WindowSweepService } from '../src/demand/window-sweep.service';
import { databaseUrl, newProductId } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule` — the harness contract-service and
 * inventory-service built, copied because services share no source (A-02).
 *
 * Four overrides, none a shortcut: the Kafka publisher (outbox rows are still written in the real
 * transaction), the relay and the purge (inert, so they do not touch a broker or rows another
 * suite asserts on), the token verifier (reads a base64 claims blob; signature checking is
 * `@rasta/nest-common`'s and `tests/e2e`'s job), and — only where a suite asks for it — the
 * database clock, so a boundary is stood on exactly (`TestClock`). Everything else is real:
 * `resolveOrganization`, `X-Organization-Id`, the guards, the tenant guard, the row locks, the
 * triggers, the database.
 */

export interface ApiHarness {
  app: INestApplication;
  prisma: PrismaService;
  publisher: InMemoryEventPublisher;
  /** A real window sweeper over this app's real repository and service; never started. */
  sweeper(overrides?: Partial<AggregationWindowSweeperOptions>): AggregationWindowSweeper;
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
 * The database clock, or an instant a suite pins (`set`). Pinned or not, it is read where the
 * service reads it — after the aggregation's lock — so a suite that moves it while a request waits
 * on that lock proves the order, not just the comparison.
 */
export class TestClock extends DatabaseClock {
  private pinned: Date | null = null;
  readonly readings: Date[] = [];

  set(at: Date | null): void {
    this.pinned = at;
  }

  override async now(tx: ExtendedPrismaClient): Promise<Date> {
    const at = this.pinned ? new Date(this.pinned.getTime()) : await super.now(tx);
    this.readings.push(at);
    return at;
  }
}

/**
 * Encodes claims into the bearer token this harness's verifier understands. Not a JWT and
 * deliberately not shaped like one: a value that looked like a signed token would invite
 * somebody to believe this suite verifies signatures.
 */
export function bearer(claims: TestClaims): string {
  return `test.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;
}

/** A person of one organization (and optionally a member of others), with the roles given. */
export function actor(
  organizationId: string,
  roles: string[],
  options: { memberships?: string[]; rastaUserId?: string | null } = {},
): string {
  return bearer({
    sub: `sub-${ulid()}`,
    ...(options.rastaUserId === null
      ? {}
      : { rastaUserId: options.rastaUserId ?? `USR-APITEST-${ulid().slice(-8)}` }),
    organizationId,
    organizationIds: [organizationId, ...(options.memberships ?? [])],
    roles,
    username: `api-test-${organizationId}`,
  });
}

/** The default buyer: a PROCUREMENT_USER of the organization (ADR-070 § 2). */
export const buyer = (organizationId: string): string =>
  actor(organizationId, ['PROCUREMENT_USER']);

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    throw RastaError.unauthenticated('Malformed token');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

/** The shared secret for service-to-service tokens, minted per run (AGENTS.md S-01). */
const INTERNAL_SECRET = randomBytes(24).toString('hex');

const SERVICE_NAME = 'procurement-service';

export function internalToken(callerService: string, organizationId?: string): Promise<string> {
  return new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300).issue(
    callerService,
    SERVICE_NAME,
    'SERVICE',
    organizationId,
  );
}

function applyEnvironment(overrides: Record<string, string>): () => void {
  const wanted = { ...overrides };
  const before = new Map(Object.keys(wanted).map((name) => [name, process.env[name]]));
  Object.assign(process.env, wanted);
  process.env.DATABASE_URL = databaseUrl();
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3107';
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

export async function startApi(
  env: Record<string, string> = {},
  options: { clock?: TestClock } = {},
): Promise<ApiHarness> {
  const restoreEnvironment = applyEnvironment(env);
  const publisher = new InMemoryEventPublisher();

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KafkaEventPublisher)
    .useValue(publisher)
    .overrideProvider(OutboxRelay)
    .useValue(inert)
    .overrideProvider(OutboxPurgeScheduler)
    .useValue(inert)
    // The timer never runs here: a suite sweeps when it says so (`harness.sweeper()`), so a window
    // a suite ends by a demand is never ended first by a sweep it did not ask for.
    .overrideProvider(AggregationWindowSweeper)
    .useValue(inert)
    .overrideProvider(AUTH_OPTIONS)
    .useFactory({
      factory: (): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        // Real: an internal token is an HS256 JWT signed with a shared secret and scoped to one
        // target service, so the Zero Trust path (ADR-020, ADR-035) is exercised for what it is.
        internalTokens: new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300),
        tokenVerifier: {
          verifyUserToken: async (token: string) => {
            const claims = decodeClaims(token);
            const organizationIds = [
              ...new Set(
                [claims.organizationId, ...(claims.organizationIds ?? [])].filter(
                  (id): id is string => typeof id === 'string' && id.length > 0,
                ),
              ),
            ];
            return {
              sub: claims.sub,
              rastaUserId: claims.rastaUserId,
              issuer: process.env.OIDC_ISSUER_URL,
              organizationId: claims.organizationId,
              organizationIds,
              // ADR-060: every role the actor holds in each membership.
              organizationRoles: organizationIds.flatMap((organizationId) =>
                claims.roles.map((role) => `${organizationId}:${role}`),
              ),
              roles: claims.roles,
              username: claims.username,
              expiresAt: Date.now() + 60_000,
            };
          },
        } as unknown as TokenVerifier,
      }),
    });
  if (options.clock) builder = builder.overrideProvider(DatabaseClock).useValue(options.clock);

  let app: INestApplication;
  let moduleRef: Awaited<ReturnType<typeof builder.compile>>;
  try {
    moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    // Same as main.ts: without it every `@Controller({ version: '1' })` route is mounted at a
    // path no client uses, and the whole suite would 404.
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // Listening once, on an ephemeral port: handed a server that is not listening, supertest
    // binds it anew for every request, and a request parked on a lock would hold the next one's
    // close.
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    // A configuration refused at startup must not leak into the next suite's environment.
    restoreEnvironment();
    throw error;
  }

  return {
    app,
    prisma: moduleRef.get(PrismaService),
    publisher,
    sweeper: (overrides = {}) =>
      new AggregationWindowSweeper(
        moduleRef.get(WindowSweepRepository),
        moduleRef.get(WindowSweepService),
        {
          intervalMs: 60_000,
          batchSize: 20,
          leaseSeconds: 60,
          retryBackoffBaseSeconds: 10,
          retryBackoffMaxSeconds: 900,
          ...overrides,
        },
      ),
    close: async () => {
      await app.close();
      restoreEnvironment();
    },
  };
}

/** A fresh Idempotency-Key, generated (never a literal: a secret scanner reads tests too). */
export const key = (): string => `key-${ulid()}`;

/**
 * Shortcuts over the HTTP API for the suites, as one caller. Each returns the supertest response,
 * so a suite asserts the status itself.
 */
export function client(api: ApiHarness, token: string, headers: Record<string, string> = {}) {
  const http = () => request(api.app.getHttpServer());
  const withHeaders = (test: request.Test) => {
    let built = test.set('authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(headers)) built = built.set(name, value);
    return built;
  };
  const post = (path: string, body: object, idempotencyKey = key()) =>
    withHeaders(http().post(path)).set('idempotency-key', idempotencyKey).send(body);
  const get = (path: string) => withHeaders(http().get(path));
  return {
    get,
    post,
    submit: (body: { productId?: string; quantity?: number; note?: string } = {}, k?: string) =>
      post('/v1/demand-requests', { productId: newProductId(), quantity: 1, ...body }, k),
    withdraw: (id: string, expectedVersion: number, reason = 'not needed any more', k?: string) =>
      post(`/v1/demand-requests/${id}/withdraw`, { expectedVersion, reason }, k),
    demand: (id: string) => get(`/v1/demand-requests/${id}`),
    demands: (query = '') => get(`/v1/demand-requests${query}`),
    aggregation: (id: string) => get(`/v1/aggregations/${id}`),
    aggregations: (query = '') => get(`/v1/aggregations${query}`),
    cancel: (id: string, expectedVersion: number, reason = 'the need went away', k?: string) =>
      post(`/v1/aggregations/${id}/cancel`, { expectedVersion, reason }, k),
  };
}
