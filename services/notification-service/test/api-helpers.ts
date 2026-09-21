import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  RastaError,
  runUnscoped,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { DispatcherConsumer } from '../src/intake/dispatcher.consumer';
import { ResolutionWorker } from '../src/resolution/resolution.worker';
import { MailWorker } from '../src/channels/mail.worker';
import { PrismaService } from '../src/prisma/prisma.service';
import { newId } from '../src/intake/intake';
import { databaseUrl } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule`.
 *
 * ## Booted from the composition root, not from a hand-built module
 *
 * The wiring is part of what is under test. The global `AuthGuard`, the global
 * `RolesGuard`, the exception filter, the context middleware, URI versioning
 * and the query pipes all come from the real graph here — which is what makes
 * "no `DELETE /v1/notifications/{id}` route exists" a fact about the service
 * rather than about this file.
 *
 * ## Two overrides, and why neither is a shortcut
 *
 * **The consumer and the worker.** Replaced with inert objects. A real
 * consumer subscribes to two topics on a broker these suites do not need; the
 * worker's behaviour is covered against a real database by
 * `resolution-failure.int-spec.ts`. Rows are seeded directly, and they are
 * seeded the way the worker writes them — intent, delivery, attempt, in-app —
 * so every foreign key and CHECK is the real one.
 *
 * **The token verifier.** Replaced with one that reads a base64 claims blob.
 * This is the one place in these suites where a signature is not checked, and
 * it is deliberate: RS256 pinning, `aud`/`iss`/`exp` and the JWKS cache are
 * covered by `auth.guard.spec.ts` in `@rasta/nest-common`. What this file
 * exercises is what happens **after** a caller is authenticated — which rows
 * they may read, which they may change, and which status a refusal carries.
 *
 * The internal token service is **not** stubbed: an internal token is an HS256
 * JWT signed with a shared secret, so it can be minted in-process — which
 * means "a valid service token is still refused" is proved for what it is.
 */

export const SERVICE_NAME = 'notification-service';

/** Minted per run; never written down (AGENTS.md S-01). */
const INTERNAL_SECRET = randomBytes(24).toString('hex');

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

/** A person acting for `organizationId`, whose memberships are `memberships` (default: that one). */
export function userToken(
  userId: string,
  organizationId: string | undefined,
  roles: string[] = ['FLEET_MANAGER'],
  memberships: string[] = organizationId ? [organizationId] : [],
): string {
  return bearer({
    sub: `sub-${userId}`,
    rastaUserId: userId,
    organizationId,
    organizationIds: memberships,
    roles,
    username: 'notification-api-test',
  });
}

export function internalToken(
  callerService = 'marketplace-service',
  purpose: 'SERVICE' | 'RELAY' = 'SERVICE',
  organizationId?: string,
): Promise<string> {
  return new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300).issue(
    callerService,
    SERVICE_NAME,
    purpose,
    organizationId,
  );
}

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    // The refusal a real JWKS verifier gives, so an unparseable credential is
    // a 401 from the product and not a 500 from the stub.
    throw RastaError.unauthenticated('Token is not verifiable');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

function applyEnvironment(): void {
  process.env.DATABASE_URL = databaseUrl();
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3113';
  process.env.KAFKA_BROKERS ??= 'localhost:9092';
  process.env.IDENTITY_SERVICE_URL ??= 'http://notificationtest.invalid:3101';
  process.env.OIDC_ISSUER_URL ??= 'http://notificationtest.invalid/realms/rasta';
  process.env.OIDC_JWKS_URI ??= 'http://notificationtest.invalid/realms/rasta/certs';
  process.env.OIDC_AUDIENCE ??= 'rasta-api';
  process.env.INTERNAL_TOKEN_SECRET = INTERNAL_SECRET;
}

const inertConsumer = {
  start: async (): Promise<void> => undefined,
  onModuleDestroy: async (): Promise<void> => undefined,
  isRunning: (): boolean => false,
};

const inertWorker = {
  start: (): void => undefined,
  stop: async (): Promise<void> => undefined,
  onApplicationShutdown: async (): Promise<void> => undefined,
  isRunning: (): boolean => false,
};

export interface ApiHarness {
  app: INestApplication;
  server: Server;
  prisma: PrismaService;
  close(): Promise<void>;
}

export async function startApi(): Promise<ApiHarness> {
  applyEnvironment();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DispatcherConsumer)
    .useValue(inertConsumer)
    .overrideProvider(ResolutionWorker)
    .useValue(inertWorker)
    // The mail worker is inert here for the same reason the other two are:
    // these suites drive HTTP, and a timer that opens sockets to a mail server
    // would make them depend on one being up. Its own behaviour is proved in
    // `email-delivery.int-spec.ts`, against a real Mailpit.
    .overrideProvider(MailWorker)
    .useValue(inertWorker)
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
          // class and this stub implements only the method it calls.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  return {
    app,
    server: app.getHttpServer() as Server,
    prisma: moduleRef.get(PrismaService),
    close: async () => {
      await app.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Seeding — exactly the rows the worker writes, so every constraint is real
// ---------------------------------------------------------------------------

export interface SeedOptions {
  organizationId: string;
  userId: string;
  /** Defaults to now; earlier values order the row further down the page. */
  createdAt?: Date;
  readAt?: Date | null;
  dismissedAt?: Date | null;
  expiresAt?: Date;
  title?: string;
  body?: string;
}

/**
 * One dispatched notification for one person: an intent, a `SENT` delivery
 * with its `SUCCESS` attempt, and the in-app row. Written unscoped because a
 * seed is not a request; every row still carries the organization.
 */
export async function seedNotification(
  prisma: PrismaService,
  options: SeedOptions,
): Promise<{ id: string; intentId: string }> {
  const now = new Date();
  const createdAt = options.createdAt ?? now;
  const intentId = newId('intent');
  const deliveryId = newId('delivery');
  const id = newId('inApp');

  await runUnscoped('api suites seed rows the way the worker writes them', async () => {
    await prisma.client.notificationIntent.create({
      data: {
        id: intentId,
        organizationId: options.organizationId,
        sourceEventId: `EVT_${ulid()}`,
        sourceEventName: 'INSURANCE_EXPIRING',
        sourceTopic: 'rasta.insurance.v1',
        sourcePartitionKey: `POL_${ulid()}`,
        occurredAt: createdAt,
        correlationId: `COR_${ulid()}`,
        ruleKey: 'insurance.expiring',
        templateKey: 'insurance.expiring.in-app',
        severity: 'WARNING',
        classification: 'ROUTINE',
        subjectType: 'InsurancePolicy',
        subjectId: `POL_${ulid()}`,
        dedupeKey: randomBytes(32).toString('hex'),
        contextData: {},
        status: 'DISPATCHED',
        resolvedAt: createdAt,
        dispatchedAt: createdAt,
      },
    });
    await prisma.client.notificationDelivery.create({
      data: {
        id: deliveryId,
        intentId,
        organizationId: options.organizationId,
        userId: options.userId,
        channel: 'IN_APP',
        status: 'SENT',
        templateKey: 'insurance.expiring.in-app',
        templateVersion: 1,
        attemptCount: 1,
        maxAttempts: 1,
        sentAt: createdAt,
      },
    });
    await prisma.client.deliveryAttempt.create({
      data: {
        id: newId('attempt'),
        deliveryId,
        organizationId: options.organizationId,
        attemptNo: 1,
        outcome: 'SUCCESS',
        startedAt: createdAt,
        finishedAt: createdAt,
      },
    });
    await prisma.client.inAppNotification.create({
      data: {
        id,
        deliveryId,
        intentId,
        organizationId: options.organizationId,
        userId: options.userId,
        ruleKey: 'insurance.expiring',
        severity: 'WARNING',
        classification: 'ROUTINE',
        subjectType: 'InsurancePolicy',
        subjectId: 'POL_SEED',
        title: options.title ?? 'بیمه‌نامه دستگاه در حال انقضا است',
        body: options.body ?? 'متن آزمون',
        actionPath: '/assets/AST_SEED',
        occurredAt: createdAt,
        createdAt,
        expiresAt: options.expiresAt ?? new Date(createdAt.getTime() + 60 * 86_400_000),
        readAt: options.readAt ?? null,
        dismissedAt: options.dismissedAt ?? null,
      },
    });
  });

  return { id, intentId };
}

/** The in-app row as the database holds it, read without a tenant context. */
export function rowById(prisma: PrismaService, id: string) {
  return runUnscoped('api suites assert on the stored row directly', () =>
    prisma.client.inAppNotification.findUnique({ where: { id } }),
  );
}
