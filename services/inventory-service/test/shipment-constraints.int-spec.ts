import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { PrismaClient } from '../src/generated/prisma';
import { client, orgAdmin, seedShipment, startApi, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, runtimeClient } from './helpers';

/** A client or an interactive transaction: what the raw statements below run on. */
type Sql = Pick<PrismaClient, '$executeRaw' | '$executeRawUnsafe'>;

/**
 * What the database refuses of a shipment on its own (migration `20261014120000_shipments`),
 * whatever a future write path forgets. Every statement runs as the **runtime role** — what the
 * service connects as — so each refusal is one the service itself cannot get past.
 */
describe('the database keeps the shipment invariants', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const refusedWith = (sql: Promise<unknown>, pattern: RegExp) =>
    expect(sql).rejects.toThrow(pattern);
  const hash = (): string => randomBytes(32).toString('hex');
  /** The shipment version each status gives it (`ck_shipment_version_matches_status`). */
  const VERSION_OF: Record<string, number> = { CREATED: 1, DISPATCHED: 2, DELIVERED: 3 };
  const trackingEvent = (
    tx: Sql,
    organizationId: string,
    shipmentId: string,
    type: string,
    occurredAt = 'now()',
    shipmentVersion = VERSION_OF[type] ?? 1,
  ) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "tracking_event" ("id", "organization_id", "shipment_id", "type",
                                     "shipment_version", "occurred_at", "recorded_at",
                                     "recorded_by", "correlation_id", "command_key_hash")
       VALUES ($1, $2, $3, $4, $5::integer, ${occurredAt}, now(), 'USR-RAW', 'corr-raw', $6)`,
      `TRK_${ulid()}`,
      organizationId,
      shipmentId,
      type,
      shipmentVersion,
      hash(),
    );
  const insertShipment = (
    tx: Sql,
    input: {
      id: string;
      organizationId: string;
      warehouseId: string;
      legCount?: number;
      status?: string;
    },
  ) =>
    tx.$executeRaw`
      INSERT INTO "shipment" ("id", "organization_id", "origin_warehouse_id",
                              "consignee_organization_id", "status", "leg_count",
                              "command_key_hash", "created_at", "created_by",
                              "created_correlation_id", "updated_at", "version")
      VALUES (${input.id}, ${input.organizationId}, ${input.warehouseId}, ${input.organizationId},
              ${input.status ?? 'CREATED'}, ${input.legCount ?? 1}::integer, ${hash()}, now(),
              'USR-RAW', 'corr-raw', now(), 1)`;
  const insertLeg = (tx: Sql, organizationId: string, shipmentId: string, sequence: number) =>
    tx.$executeRaw`
      INSERT INTO "shipment_leg" ("id", "organization_id", "shipment_id", "sequence",
                                  "carrier_name", "created_at")
      VALUES (${`SHL_${ulid()}`}, ${organizationId}, ${shipmentId}, ${sequence}::integer,
              'Raw carrier', now())`;

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  it('never erases a shipment, and keeps its legs and tracking append-only', async () => {
    const a = org();
    const { shipmentId } = await seedShipment(api, a, org());

    await refusedWith(
      raw.$executeRaw`DELETE FROM "shipment" WHERE "id" = ${shipmentId}`,
      /ck_shipment_not_erasable/,
    );
    await refusedWith(
      raw.$executeRaw`UPDATE "shipment_leg" SET "carrier_name" = 'Other' WHERE "shipment_id" = ${shipmentId}`,
      /ck_shipment_leg_immutable/,
    );
    await refusedWith(
      raw.$executeRaw`DELETE FROM "shipment_leg" WHERE "shipment_id" = ${shipmentId}`,
      /ck_shipment_leg_immutable/,
    );
    await refusedWith(
      raw.$executeRaw`UPDATE "tracking_event" SET "occurred_at" = now() - interval '1 day' WHERE "shipment_id" = ${shipmentId}`,
      /ck_tracking_event_append_only/,
    );
    await refusedWith(
      raw.$executeRaw`DELETE FROM "tracking_event" WHERE "shipment_id" = ${shipmentId}`,
      /ck_tracking_event_append_only/,
    );
    for (const table of ['shipment', 'shipment_leg', 'tracking_event']) {
      await refusedWith(raw.$executeRawUnsafe(`TRUNCATE "${table}"`), /42501|permission denied/);
    }
  });

  it('moves a shipment only CREATED → DISPATCHED → DELIVERED, one position at a time', async () => {
    const a = org();
    const { shipmentId } = await seedShipment(api, a, org());

    // Straight to DELIVERED: refused by the transition guard.
    await refusedWith(
      raw.$executeRaw`UPDATE "shipment"
         SET "status" = 'DELIVERED', "dispatched_at" = now(), "dispatched_by" = 'X',
             "delivered_at" = now(), "delivered_by" = 'X', "version" = 2
       WHERE "id" = ${shipmentId}`,
      /ck_shipment_transition|ck_shipment_version_matches_status/,
    );
    // A status the documents never decided (Q-114).
    await refusedWith(
      raw.$executeRaw`UPDATE "shipment" SET "status" = 'FAILED', "version" = 2 WHERE "id" = ${shipmentId}`,
      /ck_shipment_status|ck_shipment_transition/,
    );
    // Where it comes from and goes to never changes.
    await refusedWith(
      raw.$executeRaw`UPDATE "shipment" SET "consignee_organization_id" = ${newOrganizationId()} WHERE "id" = ${shipmentId}`,
      /ck_shipment_terms_immutable/,
    );
    // Dispatched without its timestamp: incoherent.
    await refusedWith(
      raw.$executeRaw`UPDATE "shipment" SET "status" = 'DISPATCHED', "version" = 2 WHERE "id" = ${shipmentId}`,
      /ck_shipment_status_coherent/,
    );
    // Born in any state but CREATED: refused.
    const warehouseId = (await client(api, orgAdmin(a)).createWarehouse()).body.id as string;
    await refusedWith(
      raw.$transaction(async (tx) => {
        await insertShipment(tx, {
          id: `SHP_${ulid()}`,
          organizationId: a,
          warehouseId,
          status: 'DISPATCHED',
        });
      }),
      /ck_shipment_born_created|ck_shipment_status_coherent/,
    );
  });

  it('refuses at commit a status without its tracking event, and a shipment without all its legs', async () => {
    const a = org();
    const { shipmentId } = await seedShipment(api, a, org());
    const warehouseId = (await client(api, orgAdmin(a)).createWarehouse()).body.id as string;

    await refusedWith(
      raw.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "shipment"
           SET "status" = 'DISPATCHED', "dispatched_at" = now(), "dispatched_by" = 'X',
               "version" = 2, "updated_at" = now()
         WHERE "id" = ${shipmentId}`;
      }),
      /ck_shipment_tracked/,
    );

    const lonely = `SHP_${ulid()}`;
    await refusedWith(
      raw.$transaction(async (tx) => {
        await insertShipment(tx, { id: lonely, organizationId: a, warehouseId, legCount: 2 });
        await insertLeg(tx, a, lonely, 1);
        await trackingEvent(tx, a, lonely, 'CREATED');
      }),
      /ck_shipment_legs_complete/,
    );
  });

  it('writes legs only with their shipment, in order, never one more', async () => {
    const a = org();
    const { shipmentId } = await seedShipment(api, a, org());
    const warehouseId = (await client(api, orgAdmin(a)).createWarehouse()).body.id as string;

    // A shipment that already has all its legs takes no other, later or now.
    await refusedWith(insertLeg(raw, a, shipmentId, 2), /ck_shipment_leg_with_shipment/);
    // Out of order within its own transaction.
    const skipped = `SHP_${ulid()}`;
    await refusedWith(
      raw.$transaction(async (tx) => {
        await insertShipment(tx, { id: skipped, organizationId: a, warehouseId, legCount: 2 });
        await insertLeg(tx, a, skipped, 2);
      }),
      /ck_shipment_leg_with_shipment/,
    );
  });

  it('records only the status the shipment has, at the version it has, never before an earlier event', async () => {
    const a = org();
    const { shipmentId } = await seedShipment(api, a, org());

    // DELIVERED while the shipment is CREATED.
    await refusedWith(
      trackingEvent(raw, a, shipmentId, 'DELIVERED'),
      /ck_tracking_event_matches_shipment/,
    );
    // The right status at a place in the lifecycle the shipment is not at: the history's order
    // is the shipment's version, so it cannot be claimed.
    await refusedWith(
      raw.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "shipment"
           SET "status" = 'DISPATCHED', "dispatched_at" = now(), "dispatched_by" = 'X',
               "version" = 2, "updated_at" = now()
         WHERE "id" = ${shipmentId}`;
        await trackingEvent(tx, a, shipmentId, 'DISPATCHED', 'now()', 7);
      }),
      /ck_tracking_event_matches_shipment/,
    );
    // A second CREATED: one per status.
    await refusedWith(
      trackingEvent(raw, a, shipmentId, 'CREATED'),
      /ux_tracking_event_once|23505|unique/i,
    );
    // Dispatched, but recorded as having happened before the shipment was created.
    await refusedWith(
      raw.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "shipment"
           SET "status" = 'DISPATCHED', "dispatched_at" = now(), "dispatched_by" = 'X',
               "version" = 2, "updated_at" = now()
         WHERE "id" = ${shipmentId}`;
        await trackingEvent(tx, a, shipmentId, 'DISPATCHED', "now() - interval '1 day'");
      }),
      /ck_tracking_event_in_order/,
    );
  });

  it('never lets a shipment leave another organization’s warehouse', async () => {
    const a = org();
    const b = org();
    const theirs = (await client(api, orgAdmin(b)).createWarehouse()).body.id as string;
    await refusedWith(
      raw.$transaction(async (tx) => {
        await insertShipment(tx, { id: `SHP_${ulid()}`, organizationId: a, warehouseId: theirs });
      }),
      /fk_shipment_origin_warehouse|23503|foreign key/i,
    );
  });
});
