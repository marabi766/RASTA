import { eligibilityClockWrite } from '@rasta/testing';
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

const HOUR_MS = 3_600_000;

/**
 * An OPEN window of `demands` live demands of one unit each, opened at `openedAt` for `hours`,
 * seeded through the **owner** connection — for the suites that need a window far larger than a
 * suite can submit one demand at a time. N inserts would each queue a rescan of the window at
 * commit (an insert must be checked), so the seed lifts the demand table's totals trigger for its
 * own transaction and, for a large seed, the demand row guard too (the rows are built valid: inside
 * the window, SUBMITTED, version 1). The window's own insert still checks the seeded total against
 * the seeded demands at commit. Everything after the seed is the real service.
 */
export async function seedOpenWindow(input: {
  organizationId: string;
  productId: string;
  demands: number;
  policy: 'EXTEND' | 'REFER' | 'CLOSE';
  minQuantity: number;
  openedAt: Date;
  hours: number;
}): Promise<{ aggregationId: string; demandIds: string[] }> {
  const aggregationId = `AGG_${ulid()}`;
  const demandIds = Array.from({ length: input.demands }, () => `DMD_${ulid()}`);
  const { organizationId, productId, openedAt } = input;
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  const lifted = ['tg_demand_request_totals_check', 'tg_demand_request_guard'];
  try {
    await owner.$transaction(
      async (tx) => {
        for (const trigger of lifted) {
          await tx.$executeRawUnsafe(`ALTER TABLE "demand_request" DISABLE TRIGGER "${trigger}"`);
        }
        await eligibilityClockWrite(tx)`
          INSERT INTO demand_aggregation
            (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
             min_quantity, shortfall_policy, setting_version, total_quantity, demand_count,
             extension_count, created_at, updated_at, version)
          VALUES (${aggregationId}, ${organizationId}, ${productId}, 'OPEN', ${openedAt},
                  ${new Date(openedAt.getTime() + input.hours * HOUR_MS)}, ${input.hours},
                  ${input.minQuantity}, ${input.policy}, NULL, ${input.demands}, ${input.demands},
                  0, ${openedAt}, ${openedAt}, 1)`;
        // One millisecond apart from the opening, so every demand is inside [opened_at, closes_at).
        await tx.$executeRaw`
          INSERT INTO demand_request
            (id, organization_id, aggregation_id, product_id, quantity, status, submitted_at,
             submitted_by, submitted_correlation_id, created_at, updated_at, version)
          SELECT d.id, ${organizationId}, ${aggregationId}, ${productId}, 1, 'SUBMITTED',
                 ${openedAt}::timestamptz + make_interval(secs => d.n / 1000.0),
                 'USR-SCALE-SEED', 'corr-scale-seed',
                 ${openedAt}::timestamptz + make_interval(secs => d.n / 1000.0),
                 ${openedAt}::timestamptz + make_interval(secs => d.n / 1000.0), 1
            FROM unnest(${demandIds}::text[]) WITH ORDINALITY AS d(id, n)`;
        for (const trigger of lifted) {
          await tx.$executeRawUnsafe(`ALTER TABLE "demand_request" ENABLE TRIGGER "${trigger}"`);
        }
      },
      { timeout: 600_000, maxWait: 10_000 },
    );
  } finally {
    await owner.$disconnect();
  }
  return { aggregationId, demandIds };
}

/** The guards the cleanup lifts, by table, children first. */
const GUARDED = [
  // An RFQ's frozen children, then the RFQ (plan PR 6). The RFQ and its aggregation name each other:
  // the aggregation's reference (`fk_demand_aggregation_rfq`) is deferred for the cleanup's
  // transaction, so the RFQ goes first and its aggregation after.
  ['rfq_criterion', ['tg_rfq_criterion_guard']],
  ['rfq_invitation', ['tg_rfq_invitation_guard']],
  ['rfq', ['tg_rfq_guard']],
  ['demand_request', ['tg_demand_request_guard', 'tg_demand_request_totals_check']],
  ['demand_aggregation', ['tg_demand_aggregation_guard', 'tg_demand_aggregation_totals_check']],
  // After the windows that name its versions (fk_demand_aggregation_setting).
  ['aggregation_setting', ['tg_aggregation_setting_guard']],
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
    // Long enough for a suite that seeded a window of hundreds of thousands of demands.
    await owner.$transaction(
      async (tx) => {
        // Every guard is lifted before the first delete and put back after the deferred reference
        // was checked: a table with a pending (deferred) trigger event cannot be altered.
        for (const [table, triggers] of GUARDED) {
          for (const trigger of triggers) {
            await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
          }
        }
        await tx.$executeRawUnsafe('SET CONSTRAINTS "fk_demand_aggregation_rfq" DEFERRED');
        for (const [table] of GUARDED) {
          await tx.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE "organization_id" = ANY($1::text[])`,
            organizationIds,
          );
        }
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        for (const [table, triggers] of GUARDED) {
          for (const trigger of triggers) {
            await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
          }
        }
      },
      { timeout: 600_000, maxWait: 10_000 },
    );
    await owner.idempotencyKey.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await owner.outboxMessage.deleteMany({ where: { organizationId: { in: organizationIds } } });
  } finally {
    await owner.$disconnect();
  }
}
