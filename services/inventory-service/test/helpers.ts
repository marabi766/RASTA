import { withUtcSession } from '@rasta/config';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';

/**
 * Scaffolding for the integration suites.
 *
 * Everything asserted under `test/` is a property only PostgreSQL has: the row locks that
 * serialise concurrent reservations, the CHECKs that refuse an oversell, the triggers that keep
 * the ledger append-only and a balance equal to its movements, the tenant guard against real
 * rows, the transactional coupling of a movement with its outbox row. None of it is visible to a
 * unit test, so the helpers are thin and touch the real database — the shared one `pnpm infra:up`
 * (or the CI service) runs, with random `ORG_<ulid>` tenants, as every service's suites do.
 *
 * Needs `DATABASE_URL_INVENTORY` (the runtime role of `rasta_inventory`) with this service's
 * migration applied, and `DATABASE_URL_INVENTORY_MIGRATOR` for cleanup.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_INVENTORY;
  if (!url) {
    throw new Error(
      'DATABASE_URL_INVENTORY is not set. These tests run against a real PostgreSQL; start it ' +
        "with `pnpm infra:up` and apply this service's migration first.",
    );
  }
  return withTestPool(withUtcSession(url));
}

/**
 * Connections each test client may open. The concurrency suites queue dozens of requests behind
 * one stock item's lock, and Prisma's default pool (cores × 2 + 1) would make what they prove
 * depend on the CPU count of the host they run on.
 */
export const TEST_POOL_CONNECTIONS = 16;

function withTestPool(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(TEST_POOL_CONNECTIONS));
  return parsed.toString();
}

/**
 * The owner connection the suites' cleanup alone may use to lift a guard
 * (`DATABASE_URL_INVENTORY_MIGRATOR`, `rasta_inventory_migrator`). **Required, with no fallback**
 * to the runtime URL: since D-045 the runtime role owns nothing and cannot lift a trigger.
 */
export function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_INVENTORY_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_INVENTORY_MIGRATOR is not set. The suites lift an integrity trigger only ' +
        'through the owner connection, never the runtime one; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

export const newOrganizationId = (): string => `ORG_${ulid()}`;
export const newProductId = (): string => `PRD_${ulid()}`;
export const newOrderReference = (): string => `ORD_${ulid()}`;
export const newReturnRequestId = (): string => `RET_${ulid()}`;
export const newOrderLineId = (): string => `OLN_${ulid()}`;

/** A raw client as the **runtime** role — what the service connects as. */
export function runtimeClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
}

/** One stock item's balance against its ledger: the reconciliation the suites assert. */
export interface Reconciliation {
  stockItemId: string;
  onHand: number;
  reserved: number;
  version: number;
  ledgerOnHand: number;
  ledgerReserved: number;
  movements: number;
  activeReserved: number;
}

/**
 * For every stock item of the organizations: the balance, the sums of its movements' deltas, the
 * number of movements, and the sum of its ACTIVE reservations. Reconciled means
 * `onHand = ledgerOnHand`, `reserved = ledgerReserved = activeReserved`, `version = movements`.
 */
export async function reconcile(
  client: PrismaClient,
  organizationIds: string[],
): Promise<Reconciliation[]> {
  const rows = await client.$queryRaw<
    {
      stockItemId: string;
      onHand: number;
      reserved: number;
      version: number;
      ledgerOnHand: bigint;
      ledgerReserved: bigint;
      movements: bigint;
      activeReserved: bigint;
    }[]
  >`
    SELECT s."id" AS "stockItemId", s."on_hand_quantity" AS "onHand",
           s."reserved_quantity" AS "reserved", s."version",
           COALESCE((SELECT sum(m."on_hand_delta") FROM "stock_movement" m
                      WHERE m."organization_id" = s."organization_id" AND m."stock_item_id" = s."id"), 0) AS "ledgerOnHand",
           COALESCE((SELECT sum(m."reserved_delta") FROM "stock_movement" m
                      WHERE m."organization_id" = s."organization_id" AND m."stock_item_id" = s."id"), 0) AS "ledgerReserved",
           (SELECT count(*) FROM "stock_movement" m
             WHERE m."organization_id" = s."organization_id" AND m."stock_item_id" = s."id") AS "movements",
           COALESCE((SELECT sum(r."quantity") FROM "stock_reservation" r
                      WHERE r."organization_id" = s."organization_id" AND r."stock_item_id" = s."id"
                        AND r."status" = 'ACTIVE'), 0) AS "activeReserved"
      FROM "stock_item" s
     WHERE s."organization_id" = ANY(${organizationIds})
     ORDER BY s."id"`;
  return rows.map((row) => ({
    ...row,
    ledgerOnHand: Number(row.ledgerOnHand),
    ledgerReserved: Number(row.ledgerReserved),
    movements: Number(row.movements),
    activeReserved: Number(row.activeReserved),
  }));
}

/** Asserts every stock item of the organizations reconciles, and returns how many there were. */
export async function expectReconciled(
  client: PrismaClient,
  organizationIds: string[],
): Promise<number> {
  const rows = await reconcile(client, organizationIds);
  for (const row of rows) {
    expect(row).toEqual({
      ...row,
      ledgerOnHand: row.onHand,
      ledgerReserved: row.reserved,
      activeReserved: row.reserved,
      movements: row.version,
    });
    expect(row.onHand).toBeGreaterThanOrEqual(row.reserved);
  }
  return rows.length;
}

/**
 * Removes everything the given organizations wrote. Shipments, their legs and tracking, movements,
 * stock items, reservations and warehouses are never deleted by the service (their guards), so the
 * suite's own removal goes
 * through the **owner** connection and lifts each guard for one transaction — never through the
 * runtime client under test, or the suites would teach the code to do it.
 */
export async function cleanup(organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$transaction(async (tx) => {
      for (const [table, triggers] of [
        ['return_dispatch_withdrawal', ['tg_return_dispatch_withdrawal_guard']],
        ['return_disposition', ['tg_return_disposition_guard']],
        ['return_tracking_event', ['tg_return_tracking_event_guard']],
        ['return_shipment_line', ['tg_return_shipment_line_guard']],
        ['return_shipment', ['tg_return_shipment_guard']],
        ['tracking_event', ['tg_tracking_event_guard']],
        ['shipment_leg', ['tg_shipment_leg_guard']],
        ['shipment', ['tg_shipment_guard']],
        ['stock_movement', ['tg_stock_movement_append_only']],
        ['stock_reservation', ['tg_stock_reservation_guard']],
        ['stock_item', ['tg_stock_item_guard']],
        ['warehouse', ['tg_warehouse_guard']],
      ] as const) {
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
