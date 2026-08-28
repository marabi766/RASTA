import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Shared scaffolding for the integration tests.
 *
 * Deliberately thin. The point of these tests is that they touch the real
 * database, so anything that hides the database behind a helper defeats them.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_FLEET;
  if (!url) {
    throw new Error(
      'DATABASE_URL_FLEET is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up` and copy .env.example to .env.',
    );
  }
  return url;
}

export function brokers(): string[] | null {
  const raw = process.env.KAFKA_BROKERS;
  if (!raw) return null;
  return raw
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

/**
 * Two organizations, generated fresh per run.
 *
 * Generated rather than fixed so a re-run cannot collide with rows an earlier
 * run left behind, and so the tenant-isolation tests are proving isolation
 * between two tenants that genuinely exist rather than between a tenant and an
 * empty set.
 */
export function tenants() {
  const suffix = ulid().slice(-10);
  return {
    a: `ORG-ITEST-A-${suffix}`,
    b: `ORG-ITEST-B-${suffix}`,
  };
}

export interface ActorOptions {
  organizationId: string;
  userId?: string;
  roles?: string[];
}

/**
 * Runs `fn` as a user acting for an organization.
 *
 * The tenant guard reads the organization from this context, so every call
 * that touches a scoped model must go through here — which is also what the
 * production code does on every request.
 */
export function asActor<T>(options: ActorOptions, fn: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    correlationId: `itest-${ulid()}`,
    requestId: `itest-${ulid()}`,
    organizationId: options.organizationId,
    userId: options.userId ?? `USR-ITEST-${ulid().slice(-8)}`,
    roles: options.roles ?? ['FLEET_MANAGER'],
    authType: 'USER',
    startedAt: Date.now(),
  };

  // Wrapped in `async () => fn()` rather than passed straight through, and the
  // difference is the whole test.
  //
  // A Prisma query is lazy: `client.driver.create(...)` builds a PrismaPromise
  // and runs nothing until something calls `.then` on it. A caller writing the
  // obvious `asActor(org, () => client.driver.create(...))` — a non-async
  // arrow — would have that `.then` happen on the outer `await`, after this
  // context has already closed, and the query would execute with no tenant at
  // all. The async wrapper forces the resolution to happen inside the scope.
  //
  // This is the same trap `runUnscoped` documents and guards against
  // (packages/nest-common/src/tenancy/tenant-guard.extension.ts). It was a
  // real bug in this file before these tests caught it.
  return runWithContext(context, async () => fn());
}

export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/**
 * Removes everything two test tenants wrote.
 *
 * Ordered so a foreign key never blocks a delete. Runs unscoped through the
 * base client because it spans both tenants by design.
 */
export async function cleanup(
  prisma: PrismaService,
  organizationIds: readonly string[],
): Promise<void> {
  const orgs = [...organizationIds];
  const client = prisma.client;

  await client.$executeRawUnsafe(
    `DELETE FROM usage_record WHERE organization_id = ANY($1::text[])`,
    orgs,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM assignment WHERE organization_id = ANY($1::text[])`,
    orgs,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM availability_window WHERE organization_id = ANY($1::text[])`,
    orgs,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM driver WHERE organization_id = ANY($1::text[])`,
    orgs,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM asset_ref WHERE organization_id = ANY($1::text[])`,
    orgs,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM outbox_message WHERE organization_id = ANY($1::text[])`,
    orgs,
  );
}

/** Waits for `check` to become truthy, or gives up with a readable failure. */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | null | undefined>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (last ? `; last error: ${String(last)}` : ''),
  );
}
