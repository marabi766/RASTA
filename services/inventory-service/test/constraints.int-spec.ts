import { ulid } from 'ulid';
import type { PrismaClient } from '../src/generated/prisma';
import { client, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId, runtimeClient } from './helpers';

/**
 * What the database refuses on its own, whatever a future write path forgets (ADR-056 § 3). Every
 * statement runs as the **runtime role** — what the service connects as — so each refusal is one
 * the service itself cannot get past.
 */
describe('the database keeps the stock invariants', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];
  const HASH = 'a'.repeat(64);

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const refusedWith = (sql: Promise<unknown>, pattern: RegExp) =>
    expect(sql).rejects.toThrow(pattern);

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  describe('the ledger is append-only (ADR-056 § 3, plan step 3)', () => {
    it('refuses UPDATE, DELETE and TRUNCATE on stock_movement', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);

      await refusedWith(
        raw.$executeRaw`UPDATE "stock_movement" SET "on_hand_delta" = 500 WHERE "stock_item_id" = ${stockItemId}`,
        /ck_stock_movement_append_only/,
      );
      await refusedWith(
        raw.$executeRaw`DELETE FROM "stock_movement" WHERE "stock_item_id" = ${stockItemId}`,
        /ck_stock_movement_append_only/,
      );
      // The runtime role may not TRUNCATE at all (D-045); the trigger is there for the owner.
      await refusedWith(
        raw.$executeRawUnsafe('TRUNCATE "stock_movement"'),
        /42501|permission denied/,
      );
      const left = await raw.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "stock_movement" WHERE "stock_item_id" = ${stockItemId}`;
      expect(Number(left[0]?.n)).toBe(1);
    });

    it('never erases a stock item, a reservation or a warehouse', async () => {
      const a = org();
      const { stockItemId, warehouseId } = await seedStock(api, a, 5);
      const reservation = (await client(api, orgAdmin(a)).reserve([{ stockItemId, quantity: 1 }]))
        .body.reservations[0].id as string;

      await refusedWith(
        raw.$executeRaw`DELETE FROM "stock_reservation" WHERE "id" = ${reservation}`,
        /ck_stock_reservation_not_erasable/,
      );
      await refusedWith(
        raw.$executeRaw`DELETE FROM "stock_item" WHERE "id" = ${stockItemId}`,
        /ck_stock_item_not_erasable/,
      );
      await refusedWith(
        raw.$executeRaw`DELETE FROM "warehouse" WHERE "id" = ${warehouseId}`,
        /ck_warehouse_not_erasable/,
      );
    });
  });

  describe('a balance is never negative or over-reserved (the three CHECKs)', () => {
    it('refuses a direct oversell, a negative on hand and a negative reserved', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      const step = (onHand: number, reserved: number) =>
        raw.$executeRaw`UPDATE "stock_item"
           SET "on_hand_quantity" = ${onHand}::integer, "reserved_quantity" = ${reserved}::integer,
               "version" = "version" + 1
         WHERE "id" = ${stockItemId}`;
      await refusedWith(step(5, 6), /ck_stock_item_reserved_within_on_hand/);
      await refusedWith(
        step(-1, 0),
        /ck_stock_item_on_hand_nonneg|ck_stock_item_reserved_within_on_hand/,
      );
      await refusedWith(step(5, -1), /ck_stock_item_reserved_nonneg/);
    });

    it('refuses writing the generated available quantity', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      await refusedWith(
        raw.$executeRaw`UPDATE "stock_item" SET "available_quantity" = 99 WHERE "id" = ${stockItemId}`,
        /generated column|cannot be updated|available_quantity/,
      );
    });
  });

  describe('a balance moves only with its movement: the ledger reconciles by construction', () => {
    it('refuses a balance change that is not one ledger position on', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      await refusedWith(
        raw.$executeRaw`UPDATE "stock_item" SET "on_hand_quantity" = 6 WHERE "id" = ${stockItemId}`,
        /ck_stock_item_one_position/,
      );
      await refusedWith(
        raw.$executeRaw`UPDATE "stock_item" SET "version" = "version" + 1 WHERE "id" = ${stockItemId}`,
        /ck_stock_item_one_position/,
      );
    });

    it('refuses, at commit, a balance whose position has no movement', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "stock_item"
             SET "on_hand_quantity" = 6, "version" = "version" + 1 WHERE "id" = ${stockItemId}`;
        }),
      ).rejects.toThrow(/ck_stock_item_ledgered/);
      const [item] = await raw.$queryRaw<{ onHand: number }[]>`
        SELECT "on_hand_quantity" AS "onHand" FROM "stock_item" WHERE "id" = ${stockItemId}`;
      expect(item?.onHand).toBe(5);
    });

    it('refuses a movement that misstates the balance or breaks the chain', async () => {
      const a = org();
      const { stockItemId, warehouseId } = await seedStock(api, a, 5);
      const movement = (onHandDelta: number, onHandAfter: number, itemVersion: number) =>
        raw.$executeRaw`INSERT INTO "stock_movement"
          ("id", "organization_id", "warehouse_id", "stock_item_id", "type", "on_hand_delta",
           "reserved_delta", "on_hand_after", "reserved_after", "item_version", "command_key_hash",
           "correlation_id", "created_at", "created_by")
          VALUES (${`SMV_${ulid()}`}, ${a}, ${warehouseId}, ${stockItemId}, 'RECEIPT',
                  ${onHandDelta}::integer, 0, ${onHandAfter}::integer, 0, ${itemVersion}::integer,
                  ${HASH}, 'corr', now(), 'USR-TEST')`;
      // The item stands at 5, version 1: a movement must state exactly that.
      await refusedWith(
        movement(5, 9, 1),
        /ck_stock_movement_matches_item|ux_stock_movement_item_version/,
      );
      await refusedWith(movement(3, 5, 2), /ck_stock_movement_matches_item/);
      // Moved by 2 with a movement claiming 3: the chain refuses it, and the commit with it.
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "stock_item"
             SET "on_hand_quantity" = 7, "version" = 2 WHERE "id" = ${stockItemId}`;
          await tx.$executeRaw`INSERT INTO "stock_movement"
            ("id", "organization_id", "warehouse_id", "stock_item_id", "type", "on_hand_delta",
             "reserved_delta", "on_hand_after", "reserved_after", "item_version",
             "command_key_hash", "correlation_id", "created_at", "created_by")
            VALUES (${`SMV_${ulid()}`}, ${a}, ${warehouseId}, ${stockItemId}, 'RECEIPT', 3, 0, 7, 0, 2,
                    ${HASH}, 'corr', now(), 'USR-TEST')`;
        }),
      ).rejects.toThrow(/ck_stock_movement_chain/);
    });

    it('refuses a movement whose type contradicts its deltas', async () => {
      const a = org();
      const { stockItemId, warehouseId } = await seedStock(api, a, 5);
      // Everything else is consistent — the item moved by −1 to version 2 and the chain holds —
      // so only the type is wrong: a RECEIPT never takes stock away.
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "stock_item"
             SET "on_hand_quantity" = 4, "version" = 2 WHERE "id" = ${stockItemId}`;
          await tx.$executeRaw`INSERT INTO "stock_movement"
            ("id", "organization_id", "warehouse_id", "stock_item_id", "type", "on_hand_delta",
             "reserved_delta", "on_hand_after", "reserved_after", "item_version",
             "command_key_hash", "correlation_id", "created_at", "created_by")
            VALUES (${`SMV_${ulid()}`}, ${a}, ${warehouseId}, ${stockItemId}, 'RECEIPT', -1, 0, 4, 0, 2,
                    ${HASH}, 'corr', now(), 'USR-TEST')`;
        }),
      ).rejects.toThrow(/ck_stock_movement_type_deltas/);
    });

    it('refuses a stock item born with a balance', async () => {
      const a = org();
      const { warehouseId } = await seedStock(api, a, 1);
      await refusedWith(
        raw.$executeRaw`INSERT INTO "stock_item"
          ("id", "organization_id", "warehouse_id", "product_id", "on_hand_quantity",
           "created_at", "created_by", "updated_at", "updated_by")
          VALUES (${`SKI_${ulid()}`}, ${a}, ${warehouseId}, ${newProductId()}, 100,
                  now(), 'USR-TEST', now(), 'USR-TEST')`,
        /ck_stock_item_born_empty/,
      );
    });
  });

  describe('a reservation ends once, and never points across tenants', () => {
    it('refuses moving an ended reservation, or back to ACTIVE', async () => {
      const a = org();
      const { stockItemId } = await seedStock(api, a, 5);
      const owner = client(api, orgAdmin(a));
      const id = (await owner.reserve([{ stockItemId, quantity: 1 }])).body.reservations[0]
        .id as string;
      await owner.release(id);
      await refusedWith(
        raw.$executeRaw`UPDATE "stock_reservation"
           SET "status" = 'ACTIVE', "ended_at" = NULL, "ended_by" = NULL, "version" = "version" + 1
         WHERE "id" = ${id}`,
        /ck_stock_reservation_final/,
      );
      await refusedWith(
        raw.$executeRaw`UPDATE "stock_reservation" SET "quantity" = 99 WHERE "id" = ${id}`,
        /ck_stock_reservation_terms_immutable/,
      );
    });

    it('refuses a stock item in another tenant’s warehouse (composite foreign key)', async () => {
      const a = org();
      const b = org();
      const { warehouseId } = await seedStock(api, a, 1);
      await refusedWith(
        raw.$executeRaw`INSERT INTO "stock_item"
          ("id", "organization_id", "warehouse_id", "product_id",
           "created_at", "created_by", "updated_at", "updated_by")
          VALUES (${`SKI_${ulid()}`}, ${b}, ${warehouseId}, ${newProductId()},
                  now(), 'USR-TEST', now(), 'USR-TEST')`,
        /fk_stock_item_warehouse/,
      );
    });
  });
});
