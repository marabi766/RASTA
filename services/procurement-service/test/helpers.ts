import { withUtcSession } from '@rasta/config';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';

/**
 * Scaffolding for the integration suites.
 *
 * Everything asserted under `test/` is a property only PostgreSQL has: the aggregation's row lock
 * that serialises demands, the partial unique index that keeps one OPEN window per (organization,
 * product), the triggers that keep a demand inside its window and a window's totals its demands',
 * the tenant guard against real rows, the transactional coupling of a change with its outbox row.
 * None of it is visible to a unit test, so the helpers are thin and touch the real database — the
 * shared one `pnpm infra:up` (or the CI service) runs, with random `ORG_<ulid>` tenants.
 *
 * Needs `DATABASE_URL_PROCUREMENT` (the runtime role of `rasta_procurement`) with this service's
 * migration applied, and `DATABASE_URL_PROCUREMENT_MIGRATOR` for cleanup.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_PROCUREMENT;
  if (!url) {
    throw new Error(
      'DATABASE_URL_PROCUREMENT is not set. These tests run against a real PostgreSQL; start it ' +
        "with `pnpm infra:up` and apply this service's migration first.",
    );
  }
  return withTestPool(withUtcSession(url));
}

/**
 * Connections each test client may open. The concurrency cases queue requests behind one
 * aggregation's lock, and Prisma's default pool (cores × 2 + 1) would make what they prove depend
 * on the CPU count of the host they run on.
 */
export const TEST_POOL_CONNECTIONS = 16;

function withTestPool(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(TEST_POOL_CONNECTIONS));
  return parsed.toString();
}

/**
 * The owner connection the suites' cleanup alone may use to lift a guard
 * (`DATABASE_URL_PROCUREMENT_MIGRATOR`, `rasta_procurement_migrator`). **Required, with no
 * fallback** to the runtime URL: since D-045 the runtime role owns nothing and cannot lift a
 * trigger.
 */
export function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_PROCUREMENT_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_PROCUREMENT_MIGRATOR is not set. The suites lift an integrity trigger only ' +
        'through the owner connection, never the runtime one; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

export const newOrganizationId = (): string => `ORG_${ulid()}`;
export const newProductId = (): string => `PRD_${ulid()}`;

/** A raw client as the **runtime** role — what the service connects as. */
export function runtimeClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
}

/** The guards the cleanup lifts, by table, children first. */
const GUARDED = [
  ['demand_request', ['tg_demand_request_guard', 'tg_demand_request_totals_check']],
  ['demand_aggregation', ['tg_demand_aggregation_guard', 'tg_demand_aggregation_totals_check']],
] as const;

/**
 * Removes everything the given organizations wrote. Demands and aggregations are never deleted by
 * the service (their guards), so the suite's own removal goes through the **owner** connection and
 * lifts each guard for one transaction — never through the runtime client under test, or the
 * suites would teach the code to do it.
 */
export async function cleanup(organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$transaction(async (tx) => {
      for (const [table, triggers] of GUARDED) {
        for (const trigger of triggers) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        }
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "organization_id" = ANY($1::text[])`,
          organizationIds,
        );
        for (const trigger of triggers) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
        }
      }
    });
    await owner.idempotencyKey.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await owner.outboxMessage.deleteMany({ where: { organizationId: { in: organizationIds } } });
  } finally {
    await owner.$disconnect();
  }
}
