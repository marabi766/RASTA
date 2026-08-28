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
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_MAINTENANCE;
  if (!url) {
    throw new Error(
      'DATABASE_URL_MAINTENANCE is not set. These tests run against a real PostgreSQL; ' +
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
  // A Prisma query is lazy: `client.maintenanceRequest.create(...)` builds a
  // PrismaPromise and runs nothing until something calls `.then` on it. A
  // caller writing the obvious `asActor(org, () => client.create(...))` — a
  // non-async arrow — would have that `.then` happen on the outer `await`,
  // after this context has already closed, and the query would execute with no
  // tenant at all.
  //
  // This is the same trap `runUnscoped` documents and guards against
  // (packages/nest-common/src/tenancy/tenant-guard.extension.ts). It was a real
  // bug in fleet-service's copy of this file before its tests caught it.
  return runWithContext(context, async () => fn());
}

export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/**
 * A machine the replica knows about, so a request or schedule can name it.
 *
 * In a running system this row is written by the asset-sync consumer from
 * `ASSET_CREATED`. A test database has no Kafka history to replay, and without
 * it every write path here refuses the machine as unknown — correctly.
 */
export async function seedAsset(
  prisma: PrismaService,
  assetId: string,
  organizationId: string,
  status = 'ACTIVE',
): Promise<void> {
  await prisma.client.assetRef.upsert({
    where: { id: assetId },
    create: {
      id: assetId,
      organizationId,
      name: `machine ${assetId}`,
      status,
      syncedAt: new Date(),
      sourceEvent: 'ITEST',
    },
    update: { organizationId, status, syncedAt: new Date(), sourceEvent: 'ITEST' },
  });
}

/** A meter reading, for the usage-based schedule paths. */
export async function seedMeter(
  prisma: PrismaService,
  assetId: string,
  organizationId: string,
  hourMeter: string,
): Promise<void> {
  await prisma.client.assetUsageMeter.upsert({
    where: { assetId },
    create: { assetId, organizationId, hourMeter, odometer: '0', updatedAt: new Date() },
    update: { hourMeter, updatedAt: new Date() },
  });
}

/**
 * Removes everything the test tenants wrote.
 *
 * Ordered so a foreign key never blocks a delete. Runs through raw SQL because
 * it spans both tenants by design, and because the replicas are keyed by asset
 * rather than by organization.
 */
export async function cleanup(
  prisma: PrismaService,
  organizationIds: readonly string[],
): Promise<void> {
  const orgs = [...organizationIds];
  const client = prisma.client;

  for (const table of [
    'maintenance_cost',
    'part_usage',
    'labor_entry',
    'repair_order',
    'maintenance_request',
    'maintenance_schedule',
    'asset_ref',
    'asset_usage_meter',
    'outbox_message',
  ]) {
    await client.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
  }
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
