import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AUTH_OPTIONS, type AuthGuardOptions } from '@rasta/nest-common';
import { InMemoryEventPublisher } from '../src/outbox/kafka.publisher';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl, PLATFORM_ORGANIZATION_ID } from './helpers';
import { ulid } from 'ulid';

/**
 * The HTTP surface, booted from the **real** `AppModule`.
 *
 * docs/14 § 14.5 makes an API test mandatory for every public endpoint
 * including its error paths, and § 14.10 repeats it in this service's
 * definition of done. Until this file there was none: every controller, every
 * view mapper and every DTO in the service was at zero coverage, and the paths
 * that turn a domain error into a status code — the difference between a 404
 * and a 403 on a cross-tenant read — were asserted nowhere.
 *
 * ## Booted from `AppModule`, not from a hand-built module
 *
 * The composition root is part of what is under test. A hand-assembled module
 * proves that the objects work together when a test wires them; it says
 * nothing about whether the service wires them the same way. The guards, the
 * exception filter, the context middleware, URI versioning and the platform
 * account bootstrap all come from the real graph here.
 *
 * ## The three overrides, and why each one is not a shortcut
 *
 * **Kafka publisher.** Replaced with `InMemoryEventPublisher`, which the
 * service already ships for this purpose. The outbox row is still written to
 * the real database inside the real transaction — the property that matters,
 * and the one `outbox.int-spec.ts` proves end to end. What is skipped is the
 * relay's network hop, which no controller assertion depends on.
 *
 * **The two consumers.** Replaced with inert objects so the suite does not
 * subscribe to two topics and replay them from the beginning. Their behaviour
 * is covered by `event-flow.int-spec.ts` against a real broker.
 *
 * **The token verifier.** Replaced with one that reads a base64 claims blob.
 * This is the one place in the platform's tests where a signature is not
 * checked, and it is deliberate: RS256 pinning, `aud`/`iss`/`exp` and the JWKS
 * cache are covered by `auth.guard.spec.ts`, and a *real* Keycloak token is
 * what `tests/e2e` uses. What this file exists to exercise is what happens
 * **after** a caller is authenticated — which role reaches which endpoint,
 * which record they may touch, and which status a refusal carries.
 *
 * Everything else is real: the database, the constraints, the triggers, the
 * row locks, the payment simulation, the ledger.
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

/** A financial administrator for one organization. */
export function admin(organizationId: string, roles = ['ORGANIZATION_ADMIN']): string {
  return bearer({
    sub: `sub-${ulid()}`,
    rastaUserId: `USR-APITEST-${ulid().slice(-8)}`,
    organizationId,
    organizationIds: [organizationId],
    roles,
    username: `api-test-${organizationId}`,
  });
}

/** The province oversight role, which must reach nothing in this service. */
export function auditor(organizationId: string): string {
  return admin(organizationId, ['AUDITOR']);
}

/** A platform administrator — cross-tenant reads and journal reversal. */
export function platformAdmin(organizationId = 'ORG-APITEST-PLATFORM-SCOPE'): string {
  return admin(organizationId, ['UNION_ADMIN']);
}

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    throw new Error('This harness only accepts tokens minted by `bearer()`');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

/**
 * The environment the booted application sees.
 *
 * Set on `process.env` rather than injected, because `AppModule` calls
 * `loadEconomicEnv()` in a factory — which is exactly the code path a
 * deployment uses, and worth exercising rather than bypassing.
 */
function applyEnvironment(): void {
  process.env.DATABASE_URL = databaseUrl();
  process.env.SERVICE_NAME ??= 'economic-service';
  process.env.PORT ??= '3112';
  process.env.OIDC_ISSUER_URL ??= 'http://apitest.invalid/realms/rasta';
  process.env.OIDC_JWKS_URI ??= 'http://apitest.invalid/realms/rasta/certs';
  process.env.OIDC_AUDIENCE ??= 'rasta-api';
  process.env.INTERNAL_TOKEN_SECRET ??= 'apitest_internal_secret_at_least_32_chars';
  process.env.KAFKA_BROKERS ??= 'localhost:9092';
  process.env.ECONOMIC_PLATFORM_ORGANIZATION_ID = PLATFORM_ORGANIZATION_ID;
  // The reconciliation is a timer that reports and never repairs; it has its
  // own suite and only adds noise here.
  process.env.ECONOMIC_BALANCE_AUDIT_ENABLED = 'false';
}

const inertConsumer = { onModuleInit: async () => undefined, onModuleDestroy: async () => undefined };

export async function startApi(): Promise<ApiHarness> {
  applyEnvironment();

  const publisher = new InMemoryEventPublisher();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KafkaEventPublisher)
    .useValue(publisher)
    .overrideProvider(SettlementAuthorityConsumer)
    .useValue(inertConsumer)
    .overrideProvider(RewardTriggerConsumer)
    .useValue(inertConsumer)
    .overrideProvider(AUTH_OPTIONS)
    .useFactory({
      factory: (): AuthGuardOptions => ({
        serviceName: 'economic-service',
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
          // class, and this stub implements only the one method it calls. The
          // real class is exercised by auth.guard.spec.ts and by tests/e2e.
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
