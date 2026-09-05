import { runWithContext, runUnscoped, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventPublisher } from '../src/events/publisher';
import { SupplierRepository } from '../src/supplier/supplier.repository';
import { SupplierService } from '../src/supplier/supplier.service';
import { QualificationService } from '../src/supplier/qualification.service';
import { SuspensionService } from '../src/supplier/suspension.service';
import { loadSupplierEnv, type SupplierEnv } from '../src/config/env';

/**
 * Scaffolding for the integration suites.
 *
 * ## These suites have not been run
 *
 * They were written in a phase whose verification boundary excludes running
 * anything against shared infrastructure: no `docker compose`, no `pnpm infra:*`,
 * no migration against any database. So every file under `test/` in this service
 * is **prepared and unexecuted**, and the phase report says so rather than
 * implying otherwise. Running them is an Integration Handoff item, and the first
 * run should be treated as a first run — expect to fix things.
 *
 * ## Why they exist anyway
 *
 * Everything asserted here is a property only PostgreSQL has. The CHECK
 * constraints, the two partial unique indexes, the conditional `updateMany`
 * predicates that decide a race, the transactional coupling of a decision and
 * its outbox row: none of it is visible to a unit test, and none of it would be
 * caught by mocking Prisma. Writing the assertions now means the person who runs
 * them is checking the schema rather than inventing a test for it.
 *
 * Deliberately thin. The point is to touch the real database, so anything that
 * hides it behind a helper defeats the exercise.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_SUPPLIER;
  if (!url) {
    throw new Error(
      'DATABASE_URL_SUPPLIER is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up`, copy .env.example to .env, and apply this ' +
        "service's migration to rasta_supplier first.",
    );
  }
  return url;
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

export function testEnv(overrides: Record<string, string> = {}): SupplierEnv {
  return loadSupplierEnv({
    ...process.env,
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',

    // Never verified by these suites: they call the domain with an explicit
    // `RequestContext`, so no OIDC discovery and no internal token is ever
    // exchanged. The schema demands them because the running service needs
    // them. Throwaway values, never used to sign or verify anything.
    OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI:
      process.env.OIDC_JWKS_URI ??
      'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: process.env.OIDC_AUDIENCE ?? 'rasta-api',
    INTERNAL_TOKEN_SECRET:
      process.env.INTERNAL_TOKEN_SECRET ?? 'integration_suite_unused_secret_32_chars',

    ...overrides,
  });
}

export interface Wiring {
  prisma: PrismaService;
  env: SupplierEnv;
  events: EventPublisher;
  repository: SupplierRepository;
  suppliers: SupplierService;
  qualifications: QualificationService;
  suspensions: SuspensionService;
}

/**
 * The domain, wired by hand.
 *
 * No Nest container: these suites exercise the services, and standing up the
 * whole application would drag in the auth guard, the outbox relay and a Kafka
 * connection none of them needs. The relay is deliberately **not** started, so
 * outbox rows stay in the table where a test can read them.
 */
export function wire(env: SupplierEnv = testEnv()): Wiring {
  const prisma = newPrisma();
  const events = new EventPublisher(env);
  const repository = new SupplierRepository(prisma);

  return {
    prisma,
    env,
    events,
    repository,
    suppliers: new SupplierService(prisma, repository, events),
    qualifications: new QualificationService(prisma, repository, events),
    suspensions: new SuspensionService(prisma, repository, events),
  };
}

/** A fresh organization id per test, so suites never collide or share rows. */
export function newOrganizationId(): string {
  return `ORG_${ulid()}`;
}

export function newUserId(): string {
  return `USR_${ulid()}`;
}

export function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: ulid(),
    correlationId: ulid(),
    authType: 'USER',
    roles: [],
    startedAt: Date.now(),
    ...overrides,
  } as RequestContext;
}

/** Runs `fn` as a supplier-side actor in `organizationId`. */
export function asSupplier<T>(organizationId: string, fn: () => T, userId = newUserId()): T {
  return runWithContext(context({ organizationId, userId, roles: ['SUPPLIER'] }), fn);
}

/** Runs `fn` as a platform operator in an unrelated organization. */
export function asOperator<T>(fn: () => T, organizationId = newOrganizationId()): T {
  return runWithContext(
    context({ organizationId, userId: newUserId(), roles: ['UNION_ADMIN'] }),
    fn,
  );
}

/**
 * Removes everything one organization wrote.
 *
 * Children before parents, because every foreign key is `ON DELETE RESTRICT` —
 * which is the invariant `constraints.int-spec.ts` proves, and the reason
 * cleanup here has to be explicit rather than a cascade.
 */
export async function cleanup(prisma: PrismaService, organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  const where = { organizationId: { in: organizationIds } };

  await runUnscoped('integration cleanup removes exactly what the suite wrote', async () => {
    await prisma.client.qualificationEvidence.deleteMany({ where });
    await prisma.client.qualification.deleteMany({ where });
    await prisma.client.suspension.deleteMany({ where });
    await prisma.client.supplierCapability.deleteMany({ where });
    await prisma.client.supplier.deleteMany({ where });
    await prisma.client.outboxMessage.deleteMany({ where });
  });
}

/** Every outbox row one organization produced, oldest first. */
export async function outboxFor(prisma: PrismaService, organizationId: string) {
  return runUnscoped('the outbox carries its own tenant column', () =>
    prisma.client.outboxMessage.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  );
}
