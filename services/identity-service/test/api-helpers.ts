import { randomBytes } from 'node:crypto';
import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxRelay,
  RastaError,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import { AppModule, ENV } from '../src/app.module';
import { withAuthGuardRefusalAudit } from '../src/security-events/auth-guard-refusal';
import { loadIdentityEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';
import { SecurityEventOutboxStore } from '../src/security-events/security-event-outbox.store';
import { SECURITY_EVENT_RELAY } from '../src/security-events/security-event.relay';
import { databaseUrl } from './helpers';

/**
 * The identity HTTP surface, booted from the **real** `AppModule` (AUD-004
 * Phase C1).
 *
 * The composition root is part of what is under test: the global auth and
 * roles guards, the request-context middleware, URI versioning and — the point
 * of this phase — the refusal filter registered as the global exception filter.
 * A hand-built module would prove the pieces work when a test wires them, not
 * that the service does.
 *
 * ## The overrides, and why none is a shortcut
 *
 * **The environment.** Built with `loadIdentityEnv` from explicit values rather
 * than read from `process.env`, so nothing here mutates the process for any
 * other suite, and Keycloak synchronisation is off — the one flag this service
 * defines for exactly this purpose (D-020).
 *
 * **The token verifier.** Reads a base64 claims blob — the same harness
 * audit-service uses. Signature, `aud`, `iss` and `exp` are proven in
 * `@rasta/nest-common`'s `auth.guard.spec.ts`; what these suites exercise is
 * what happens **after** a caller is authenticated.
 *
 * **The domain outbox relay.** Inert. It publishes whatever `outbox_message`
 * holds, and on a shared development database that is other suites' rows.
 * Nothing asserted here touches the domain outbox.
 *
 * **The refusal relay.** Inert unless a suite asks for it: the PostgreSQL suite
 * drives the claim protocol step by step and must not race a background poller;
 * the Kafka flow suite runs the real one.
 */

export const SERVICE_NAME = 'identity-service';

/** Minted per run — a literal would be indistinguishable from a real secret (S-01). */
const INTERNAL_SECRET = randomBytes(24).toString('hex');

/**
 * The internal tokens the booted service will accept — the same instance the
 * harness configures the guard with, so a test can act as another service
 * exactly as that service would (ADR-020, ADR-035).
 */
const internalTokens = new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300);

/**
 * Verifies an internal token minted by the booted service, as the service it
 * was minted for would. Used by the audit-service stand-in to prove the
 * correction command authenticates its lookup exactly as ADR-020/035 require.
 */
export function verifyInternalToken(token: string, audience: string) {
  return internalTokens.verify(token, audience);
}

/** A service-to-service token this service's auth guard verifies as genuine. */
export function serviceToken(
  callerService = 'fleet-service',
  organizationId?: string,
): Promise<string> {
  return internalTokens.issue(callerService, SERVICE_NAME, 'SERVICE', organizationId);
}

export interface TestClaims {
  sub: string;
  rastaUserId?: string;
  organizationId?: string;
  organizationIds?: string[];
  roles: string[];
  username?: string;
}

/** Not a JWT and deliberately not shaped like one. */
export function bearer(claims: TestClaims): string {
  return `test.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;
}

export interface Caller {
  userId: string;
  organizationId?: string;
  organizationIds?: string[];
  roles?: string[];
}

/** A user token for `caller`, as the auth guard will read it. */
export function userToken(caller: Caller): string {
  return bearer({
    sub: `sub-${ulid()}`,
    rastaUserId: caller.userId,
    organizationId: caller.organizationId,
    organizationIds:
      caller.organizationIds ?? (caller.organizationId ? [caller.organizationId] : []),
    roles: caller.roles ?? ['FLEET_MANAGER'],
    username: 'identity-refusal-itest',
  });
}

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    // The refusal a real verifier gives, so the filter maps it to a 401.
    throw RastaError.unauthenticated('Token is not verifiable');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

/** A relay that does nothing — see the header. */
export const inertRelay = {
  start: (): void => undefined,
  stop: async (): Promise<void> => undefined,
  tick: async (): Promise<number> => 0,
};

export interface IdentityApiOptions {
  /** `SECURITY_EVENT_CAPTURE_TIMEOUT_MS`. Generous by default; the timeout suite lowers it. */
  captureTimeoutMs?: number;
  /** `SECURITY_EVENT_FLUSH_INTERVAL_MS`, for the real refusal relay. */
  flushIntervalMs?: number;
  /**
   * `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS`. The production default (60)
   * unless a suite needs to watch a window close — configuration, not a bypass.
   */
  aggregationWindowSeconds?: number;
  /** Run the real refusal relay against Kafka. Inert otherwise. */
  runSecurityRelay?: boolean;
  /** Replaces the refusal store — used to inject a failing write. */
  securityEventStore?: unknown;
  /**
   * `AUDIT_SERVICE_URL` — where the audit correction command looks its target
   * up (AUD-003 correction). Defaults to an address nothing listens on, so a suite that
   * never issues a correction cannot accidentally depend on one.
   */
  auditServiceUrl?: string;
  /** Run the real standard-outbox relay against Kafka. Inert otherwise. */
  runDomainRelay?: boolean;
}

export interface IdentityApiHarness {
  app: INestApplication;
  moduleRef: TestingModule;
  prisma: PrismaService;
  store: SecurityEventOutboxStore;
  close(): Promise<void>;
}

export async function startIdentityApi(
  options: IdentityApiOptions = {},
): Promise<IdentityApiHarness> {
  const env = loadIdentityEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    SERVICE_VERSION: '0.1.0-itest',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    KAFKA_CLIENT_ID: `identity-itest-${ulid().slice(-8)}`,
    OIDC_ISSUER_URL: 'http://identitytest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://identitytest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: INTERNAL_SECRET,
    KEYCLOAK_URL: 'http://identitytest.invalid',
    KEYCLOAK_REALM: 'rasta',
    KEYCLOAK_BACKEND_CLIENT_ID: 'identity-itest',
    KEYCLOAK_BACKEND_CLIENT_SECRET: randomBytes(16).toString('hex'),
    KEYCLOAK_SYNC_ENABLED: 'false',
    SECURITY_EVENT_CAPTURE_TIMEOUT_MS: String(options.captureTimeoutMs ?? 5000),
    SECURITY_EVENT_FLUSH_INTERVAL_MS: String(options.flushIntervalMs ?? 1000),
    AUDIT_SERVICE_URL: options.auditServiceUrl ?? 'http://127.0.0.1:9',
    AUDIT_REQUEST_TIMEOUT_MS: '2000',
    ...(options.aggregationWindowSeconds !== undefined
      ? { SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS: String(options.aggregationWindowSeconds) }
      : {}),
  });

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(AUTH_OPTIONS)
    .useFactory({
      // Wrapped exactly as `app.module.ts` wraps it, so these suites boot the
      // production refusal-audit observation of the auth guard's own tenant
      // refusal rather than a harness that quietly lacks it (Phase C10).
      factory: (): AuthGuardOptions =>
        withAuthGuardRefusalAudit({
          serviceName: SERVICE_NAME,
          internalTokens,
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
            // JUSTIFIED-ANY: the guard depends on the concrete TokenVerifier class
            // and this stub implements only the method it calls.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        }),
    });

  if (!options.runDomainRelay) {
    builder = builder.overrideProvider(OutboxRelay).useValue(inertRelay);
  }
  if (!options.runSecurityRelay) {
    builder = builder.overrideProvider(SECURITY_EVENT_RELAY).useValue(inertRelay);
  }
  if (options.securityEventStore !== undefined) {
    builder = builder
      .overrideProvider(SecurityEventOutboxStore)
      .useValue(options.securityEventStore);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  // Same as `main.ts`: without it every versioned route 404s for the wrong reason.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  return {
    app,
    moduleRef,
    prisma: moduleRef.get(PrismaService),
    store: moduleRef.get(SecurityEventOutboxStore),
    close: async () => {
      await app.close();
    },
  };
}
