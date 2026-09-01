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
import { MALWARE_SCANNER } from '../src/tokens';
import { ScanWorker } from '../src/scanning/scan.worker';
import type { MalwareScanner } from '../src/scanning/scanner.port';
import { databaseUrl } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule`.
 *
 * `docs/14` § 14.5 makes an API test mandatory for every public endpoint
 * including its error paths. Without this file the controller, the view
 * mapper, the versioning and the composition root sit at zero coverage, and
 * the paths that turn a domain error into a status code — the difference
 * between a 404 and a 422 on a document that exists but may not be handed over
 * — would be asserted nowhere.
 *
 * ## Booted from `AppModule`, not from a hand-built module
 *
 * The composition root is part of what is under test, and for this service it
 * is the *most* important part: `AppModule` is the single line that decides
 * which `MalwareScanner` the platform runs with. A hand-assembled module would
 * prove the objects work together when a test wires them and say nothing about
 * what a deployment actually binds. {@link startApi} therefore takes the real
 * graph — including the real `NoOpMalwareScanner` — unless a test explicitly
 * asks for something else.
 *
 * ## The overrides, and why none is a shortcut
 *
 * **Kafka publisher.** Replaced with `InMemoryEventPublisher`, which the
 * service already ships. The outbox row is still written to the real database
 * inside the real transaction — the property that matters. What is skipped is
 * the relay's network hop, which no controller assertion depends on.
 *
 * **The outbox relay.** Inert, and that is a correctness fix rather than a
 * speed one: it polls **every** pending row in the database, so while one of
 * these applications is alive it drains rows other suites in the same run
 * wrote and are about to assert are still pending.
 *
 * **The token verifier.** Replaced with one that reads a base64 claims blob.
 * The one place in this service's tests where a signature is not checked, and
 * deliberate: RS256 pinning, `aud`/`iss`/`exp` and the JWKS cache are covered
 * in `@rasta/nest-common`, and a *real* Keycloak token is what `tests/e2e`
 * uses. What this file exercises is what happens **after** a caller is
 * authenticated — which role reaches which endpoint, which document they may
 * touch, and which status a refusal carries.
 *
 * **The malware scanner — only when a test asks.** See {@link StartApiOptions}.
 *
 * Everything else is real: the database, the CHECK constraints, MinIO, the
 * signed URLs, the magic-number inspection and the download policy.
 */

export interface ApiHarness {
  app: INestApplication;
  prisma: PrismaService;
  publisher: InMemoryEventPublisher;
  /**
   * The scan worker from the booted graph, for driving the queue by hand.
   *
   * Its poll timer is off (`DOCUMENT_SCAN_WORKER_ENABLED=false` below), so a
   * document stays `PENDING` until a test asks for it to move. That is the
   * only way these assertions can be deterministic: a running timer would race
   * every "this is not downloadable yet" check, and a suite that has to sleep
   * to be right is one that is flaky on a slow runner.
   */
  worker: ScanWorker;
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

/** The ordinary document-handling role. */
export function orgAdmin(organizationId: string): string {
  return actor(organizationId, ['ORGANIZATION_ADMIN']);
}

/** A platform operator — reads across tenants, but cannot redeem their intents. */
export function platformAdmin(organizationId = 'ORG-APITEST-PLATFORM'): string {
  return actor(organizationId, ['UNION_ADMIN']);
}

/** The province oversight role, which must reach nothing in this service. */
export function auditor(organizationId: string): string {
  return actor(organizationId, ['AUDITOR']);
}

/** A role that exists on the platform but has no business with documents. */
export function driver(organizationId: string): string {
  return actor(organizationId, ['DRIVER']);
}

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    // `RastaError.unauthenticated`, not a plain `Error`, because the real
    // `TokenVerifier` refuses an unverifiable token that way and the status
    // code is part of what these tests assert. A plain throw would surface as
    // a 500 and quietly turn "we reject bad tokens" into "we crash on them".
    throw RastaError.unauthenticated('The bearer token could not be verified');
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

const SERVICE_NAME = 'document-service';

export function internalToken(
  callerService: string,
  options: { organizationId?: string; targetService?: string } = {},
): Promise<string> {
  return new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300).issue(
    callerService,
    options.targetService ?? SERVICE_NAME,
    'SERVICE',
    options.organizationId,
  );
}

/**
 * The environment the booted application sees.
 *
 * Set on `process.env` rather than injected, because `AppModule` calls
 * `loadDocumentEnv()` in a factory — which is exactly the code path a
 * deployment uses, and worth exercising rather than bypassing.
 *
 * Note what is *not* set: there is no scanning-related variable to set. The
 * flag that used to make unscanned documents downloadable no longer exists, so
 * a suite cannot configure its way past the invariant even by accident.
 */
function applyEnvironment(): void {
  process.env.DATABASE_URL = databaseUrl();
  // `jest.setup.cjs` silences Nest's logger, but this service logs through
  // pino, whose level comes from configuration. Without this, every deliberate
  // 4xx in the suite prints a full structured record and buries the assertion
  // that actually failed. `VERBOSE_TEST_LOGS=1` brings them back, which is
  // what to do when diagnosing one.
  if (!process.env.VERBOSE_TEST_LOGS) process.env.LOG_LEVEL = 'fatal';
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3114';
  process.env.OIDC_ISSUER_URL ??= 'http://apitest.invalid/realms/rasta';
  process.env.OIDC_JWKS_URI ??= 'http://apitest.invalid/realms/rasta/certs';
  process.env.OIDC_AUDIENCE ??= 'rasta-api';
  process.env.INTERNAL_TOKEN_SECRET = INTERNAL_SECRET;
  process.env.KAFKA_BROKERS ??= 'localhost:9092';

  // Real MinIO, the same values `.env.example` carries. The uploads and
  // downloads in these suites genuinely cross the network to a bucket.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_REGION ??= 'us-east-1';
  process.env.S3_ACCESS_KEY ??= 'rasta_minio_admin';
  process.env.S3_SECRET_KEY ??= 'rasta_minio_dev_password';
  process.env.S3_BUCKET_DOCUMENTS ??= 'rasta-documents';
  process.env.S3_FORCE_PATH_STYLE = 'true';

  // Real ClamAV, because `AppModule` composes it and this file's whole point
  // is booting the composition a deployment actually gets (ADR-049). CI sets
  // the socket path; a developer machine falls back to the loopback TCP
  // listener `docker compose` publishes, which is the only transport a Linux
  // container can offer a Node process on Windows.
  if (!process.env.DOCUMENT_CLAMAV_SOCKET_PATH) {
    process.env.DOCUMENT_CLAMAV_HOST ??= '127.0.0.1';
    process.env.DOCUMENT_CLAMAV_PORT ??= '3310';
  }
  // Frozen at the pinned image's digest in CI, where freshclam is off for
  // determinism. The freshness rule itself is proven in
  // `clamav.scanner.spec.ts` against a controlled clock and its production
  // default in `env.spec.ts`.
  process.env.DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS ??= '8760';
  // The timer stays off; tests call `worker.tick()`. See `ApiHarness.worker`.
  process.env.DOCUMENT_SCAN_WORKER_ENABLED = 'false';
}

const inertRelay = { start: () => undefined, stop: async () => undefined };

export interface StartApiOptions {
  /**
   * A scanner to bind instead of the one `AppModule` composes.
   *
   * Omit it — and every suite testing production behaviour must omit it — to
   * run the real `ClamAvMalwareScanner` the composition root selects.
   * `AlwaysCleanScanner` is for the tests whose subject is the download path
   * and its HTTP surface rather than the engine, so that they do not depend on
   * a scanner container being reachable; the engine itself, including EICAR,
   * is exercised for real in `clamav-scan.int-spec.ts`.
   *
   * This override exists in `test/` and nowhere else. There is no environment
   * variable and no production code path that can produce the same effect.
   */
  scanner?: MalwareScanner;
}

export async function startApi(options: StartApiOptions = {}): Promise<ApiHarness> {
  applyEnvironment();

  const publisher = new InMemoryEventPublisher();

  const builder = Test.createTestingModule({ imports: [AppModule] })
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
          // class is exercised in @rasta/nest-common and by tests/e2e.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    });

  if (options.scanner) {
    builder.overrideProvider(MALWARE_SCANNER).useValue(options.scanner);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  // Same as main.ts: without it every `@Controller({ version: '1' })` route is
  // mounted at a path no client uses, and the whole suite would 404.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  return {
    app,
    prisma: moduleRef.get(PrismaService),
    publisher,
    worker: moduleRef.get(ScanWorker),
    close: async () => {
      await app.close();
    },
  };
}

/** The scanner the booted application actually holds, for assertions on it. */
export function scannerOf(harness: ApiHarness): MalwareScanner {
  return harness.app.get<MalwareScanner>(MALWARE_SCANNER);
}

/** A tenant identifier that cannot collide with another run's. */
export function apiTenant(label: string): string {
  return `ORG-APITEST-${label}-${ulid().slice(-10)}`;
}
