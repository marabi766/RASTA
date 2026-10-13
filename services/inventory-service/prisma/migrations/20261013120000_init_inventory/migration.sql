-- =============================================================================
-- inventory-service — initial migration (COM-006 PR 1, ADR-056).
--
-- Warehouses, stock items, the append-only stock movement ledger, reservations,
-- this service's Idempotency-Key store and the platform's outbox. The outbox
-- arrives folded into this one migration, as supplier's, construction's and
-- contract's did: its objects are verified by
-- `scripts/verify-migration-reversible.mjs inventory` (EXPECTED.inventory), not
-- by the by-name outbox verifiers (`verify-outbox-claim-migration.mjs` lists it
-- as folded).
--
-- `organization_id` is the warehouse owner on every domain table (ADR-056 § 5's
-- ownerOrganizationId is the tenant-guard column) and leads every composite
-- index. Children reference their parent through (organization_id, …), so a row
-- can never point at another tenant's warehouse, stock item or reservation.
--
-- Every instant is TIMESTAMPTZ(3) from the start (D-048). Quantities are
-- integers in the product's base unit (Q-105).
-- =============================================================================

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'RESERVE', 'RELEASE', 'ISSUE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateTable
CREATE TABLE "warehouse" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" geography(Point, 4326),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "on_hand_quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "available_quantity" INTEGER GENERATED ALWAYS AS ("on_hand_quantity" - "reserved_quantity") STORED,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "stock_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "stock_item_id" TEXT NOT NULL,
    "holder_organization_id" TEXT NOT NULL,
    "order_reference" TEXT,
    "quantity" INTEGER NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(3),
    "command_key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "stock_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "stock_item_id" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "on_hand_delta" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL,
    "on_hand_after" INTEGER NOT NULL,
    "reserved_after" INTEGER NOT NULL,
    "item_version" INTEGER NOT NULL,
    "reservation_id" TEXT,
    "source_reference" TEXT,
    "command_key_hash" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "claim_token" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("organization_id", "endpoint", "key")
);

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "organization_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "claim_token" TEXT,
    "claim_owner" TEXT,
    "claim_expires_at" TIMESTAMPTZ(3),
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "stream_seq" BIGINT,
    "is_stream_head" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_stream_sequence" (
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "next_seq" BIGINT NOT NULL DEFAULT 1,
    "published_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_stream_sequence_pkey" PRIMARY KEY ("topic","partition_key")
);

-- ---- keys and indexes -------------------------------------------------------

-- The targets of the composite foreign keys below: (organization_id, …) first.
CREATE UNIQUE INDEX "ux_warehouse_org_id" ON "warehouse"("organization_id", "id");
CREATE UNIQUE INDEX "ux_stock_item_org_warehouse_id" ON "stock_item"("organization_id", "warehouse_id", "id");
CREATE UNIQUE INDEX "ux_stock_reservation_org_item_id" ON "stock_reservation"("organization_id", "stock_item_id", "id");

-- One stock item per product per warehouse (ADR-056 § 3), within the owner.
CREATE UNIQUE INDEX "ux_stock_item_org_warehouse_product" ON "stock_item"("organization_id", "warehouse_id", "product_id");
CREATE UNIQUE INDEX "ux_stock_item_org_id" ON "stock_item"("organization_id", "id");

-- The database backstop of the Idempotency-Key (deviation 1 of the plan): a command's key, hashed
-- with its route, applies at most one movement and one reservation per stock item — even after
-- the key's 24 hours in `idempotency_key` are over. The raw key is never stored here (S-09).
CREATE UNIQUE INDEX "ux_stock_movement_command" ON "stock_movement"("organization_id", "command_key_hash", "stock_item_id");
CREATE UNIQUE INDEX "ux_stock_reservation_command" ON "stock_reservation"("organization_id", "command_key_hash", "stock_item_id");

-- The ledger of one stock item is a chain: one movement per position (`item_version`).
CREATE UNIQUE INDEX "ux_stock_movement_item_version" ON "stock_movement"("organization_id", "stock_item_id", "item_version");

-- A reservation is reserved once and ended once.
CREATE UNIQUE INDEX "ux_stock_movement_reserve_once" ON "stock_movement"("organization_id", "reservation_id")
  WHERE "type" = 'RESERVE';
CREATE UNIQUE INDEX "ux_stock_movement_end_once" ON "stock_movement"("organization_id", "reservation_id")
  WHERE "type" IN ('RELEASE', 'ISSUE');

-- Reads.
CREATE INDEX "ix_stock_movement_org_item" ON "stock_movement"("organization_id", "stock_item_id", "id");
CREATE INDEX "ix_stock_movement_org_warehouse" ON "stock_movement"("organization_id", "warehouse_id", "id");
CREATE INDEX "ix_stock_reservation_org_status" ON "stock_reservation"("organization_id", "status", "id");
CREATE INDEX "ix_stock_reservation_org_item_status" ON "stock_reservation"("organization_id", "stock_item_id", "status", "expires_at");

-- The expiry sweeper's question, for every tenant at once: which ACTIVE reservations are due.
-- A single column, so it leads with no tenant by necessity (the sweeper runs outside any request).
CREATE INDEX "ix_stock_reservation_due" ON "stock_reservation"("expires_at")
  WHERE "status" = 'ACTIVE' AND "expires_at" IS NOT NULL;

CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

CREATE INDEX "ix_outbox_pending" ON "outbox_message"("published_at", "created_at");

-- ---- foreign keys: always through the owner ---------------------------------

ALTER TABLE "stock_item" ADD CONSTRAINT "fk_stock_item_warehouse"
  FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouse"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "stock_reservation" ADD CONSTRAINT "fk_stock_reservation_item"
  FOREIGN KEY ("organization_id", "warehouse_id", "stock_item_id")
  REFERENCES "stock_item"("organization_id", "warehouse_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "stock_movement" ADD CONSTRAINT "fk_stock_movement_item"
  FOREIGN KEY ("organization_id", "warehouse_id", "stock_item_id")
  REFERENCES "stock_item"("organization_id", "warehouse_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A movement of a reservation is a movement of that reservation's own stock item.
ALTER TABLE "stock_movement" ADD CONSTRAINT "fk_stock_movement_reservation"
  FOREIGN KEY ("organization_id", "stock_item_id", "reservation_id")
  REFERENCES "stock_reservation"("organization_id", "stock_item_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- ---- warehouse ----------------------------------------------------------------

ALTER TABLE "warehouse" ADD CONSTRAINT "ck_warehouse_id"
  CHECK ("id" ~ '^WHS_[0-9A-HJKMNP-TV-Z]{26}$');

-- A name, trimmed, of a bounded length: shown to people, never on an event.
ALTER TABLE "warehouse" ADD CONSTRAINT "ck_warehouse_name"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 200);

-- Only ACTIVE exists in PR 1: the lifecycle (deactivate, close with stock on hand) is Q-108.
-- A CHECK, not an enum, so the decision can widen it reversibly.
ALTER TABLE "warehouse" ADD CONSTRAINT "ck_warehouse_status"
  CHECK ("status" IN ('ACTIVE'));

ALTER TABLE "warehouse" ADD CONSTRAINT "ck_warehouse_actor_recorded"
  CHECK (btrim("organization_id") <> '' AND btrim("created_by") <> ''
         AND btrim("created_correlation_id") <> '');

ALTER TABLE "warehouse" ADD CONSTRAINT "ck_warehouse_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "warehouse" ADD CONSTRAINT "ck_warehouse_timestamps_ordered"
  CHECK ("updated_at" >= "created_at");

-- ---- stock_item: the balance (ADR-056 § 3) ------------------------------------

ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_item_id"
  CHECK ("id" ~ '^SKI_[0-9A-HJKMNP-TV-Z]{26}$');

-- The product is marketplace's, referenced opaquely and never resolved (ADR-056 § 1, Q-105).
ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_item_product_id"
  CHECK ("product_id" ~ '^PRD_[0-9A-HJKMNP-TV-Z]{26}$');

-- The three CHECKs of ADR-056 § 3. With them an oversell is not a bug the code must avoid but a
-- write the database refuses: `available_quantity` = on hand − reserved can never be negative.
ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_item_on_hand_nonneg"
  CHECK ("on_hand_quantity" >= 0);

ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_item_reserved_nonneg"
  CHECK ("reserved_quantity" >= 0);

ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_item_reserved_within_on_hand"
  CHECK ("reserved_quantity" <= "on_hand_quantity");

-- `version` is the item's position in its own ledger: the number of movements applied.
ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_item_version_nonneg"
  CHECK ("version" >= 0);

ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_item_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("updated_by") <> '');

ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_item_timestamps_ordered"
  CHECK ("updated_at" >= "created_at");

-- ---- stock_reservation --------------------------------------------------------

ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_id"
  CHECK ("id" ~ '^SRV_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_holder"
  CHECK (btrim("holder_organization_id") <> '');

-- An opaque reference to an order or a purchase order of another service (ADR-056 § 1).
ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_order_reference"
  CHECK ("order_reference" IS NULL OR "order_reference" ~ '^(ORD|PO)_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_command_key_hash"
  CHECK ("command_key_hash" ~ '^[0-9a-f]{64}$');

-- ACTIVE has not ended; every other status has, and says when and by whom.
ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_end_coherent"
  CHECK (("status" = 'ACTIVE') = ("ended_at" IS NULL)
         AND ("ended_at" IS NULL) = ("ended_by" IS NULL));

ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_expiry_after_creation"
  CHECK ("expires_at" IS NULL OR "expires_at" > "created_at");

-- Only a reservation with an expiry can expire.
ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_expired_had_expiry"
  CHECK ("status" <> 'EXPIRED' OR "expires_at" IS NOT NULL);

ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("created_correlation_id") <> '');

ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_timestamps_ordered"
  CHECK ("updated_at" >= "created_at" AND ("ended_at" IS NULL OR "ended_at" >= "created_at"));

-- ---- stock_movement: the ledger ----------------------------------------------

ALTER TABLE "stock_movement" ADD CONSTRAINT "ck_stock_movement_id"
  CHECK ("id" ~ '^SMV_[0-9A-HJKMNP-TV-Z]{26}$');

-- What each type does to the two balances (ADR-056 § 3), and whether it is a reservation's.
ALTER TABLE "stock_movement" ADD CONSTRAINT "ck_stock_movement_type_deltas"
  CHECK (
    ("type" = 'RECEIPT'    AND "on_hand_delta" > 0 AND "reserved_delta" = 0
                           AND "reservation_id" IS NULL)
 OR ("type" = 'RESERVE'    AND "on_hand_delta" = 0 AND "reserved_delta" > 0
                           AND "reservation_id" IS NOT NULL)
 OR ("type" = 'RELEASE'    AND "on_hand_delta" = 0 AND "reserved_delta" < 0
                           AND "reservation_id" IS NOT NULL)
 OR ("type" = 'ISSUE'      AND "on_hand_delta" < 0 AND "reserved_delta" = "on_hand_delta"
                           AND "reservation_id" IS NOT NULL)
 OR ("type" = 'ADJUSTMENT' AND "on_hand_delta" <> 0 AND "reserved_delta" = 0
                           AND "reservation_id" IS NULL)
  );

ALTER TABLE "stock_movement" ADD CONSTRAINT "ck_stock_movement_after_valid"
  CHECK ("on_hand_after" >= 0 AND "reserved_after" >= 0 AND "reserved_after" <= "on_hand_after");

ALTER TABLE "stock_movement" ADD CONSTRAINT "ck_stock_movement_item_version_positive"
  CHECK ("item_version" >= 1);

ALTER TABLE "stock_movement" ADD CONSTRAINT "ck_stock_movement_source_reference"
  CHECK ("source_reference" IS NULL OR "source_reference" ~ '^(ORD|PO|ADJ)_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "stock_movement" ADD CONSTRAINT "ck_stock_movement_command_key_hash"
  CHECK ("command_key_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "stock_movement" ADD CONSTRAINT "ck_stock_movement_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("correlation_id") <> '');

-- ---- idempotency_key ----------------------------------------------------------

ALTER TABLE "idempotency_key"
  ADD CONSTRAINT "ck_idempotency_state" CHECK ("state" IN ('IN_PROGRESS', 'COMPLETED')),
  ADD CONSTRAINT "ck_idempotency_key_not_blank" CHECK (length(btrim("key")) > 0),
  ADD CONSTRAINT "ck_idempotency_claim_token_not_blank" CHECK (length(btrim("claim_token")) > 0),
  ADD CONSTRAINT "ck_idempotency_completed_has_response" CHECK (
    "state" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "response_body" IS NOT NULL)
  );

-- =============================================================================
-- Triggers. The runtime role owns nothing and can disable none of them (D-045).
-- =============================================================================

-- ---- a warehouse is never erased, and where it came from never changes ---------

CREATE FUNCTION "warehouse_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_warehouse_origin_immutable: a warehouse keeps its owner and origin'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_warehouse_not_erasable: a warehouse is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_warehouse_guard"
  BEFORE UPDATE OR DELETE ON "warehouse"
  FOR EACH ROW EXECUTE FUNCTION "warehouse_guard"();

CREATE TRIGGER "tg_warehouse_no_truncate"
  BEFORE TRUNCATE ON "warehouse"
  FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_guard"();

-- ---- a stock item: born empty, moved only one ledger position at a time --------
--
-- A stock item is created empty at version 0. Its balances change only together with its
-- `version`, by exactly one, so every change has a ledger position; `tg_stock_movement_chain`
-- requires the movement at that position to state the balance it left, and
-- `tg_stock_item_ledger_check` refuses, at commit, a balance whose position has no movement.
-- The balance therefore equals the sum of its movements by construction, not by convention.

CREATE FUNCTION "stock_item_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."on_hand_quantity" <> 0 OR NEW."reserved_quantity" <> 0 OR NEW."version" <> 0 THEN
      RAISE EXCEPTION 'ck_stock_item_born_empty: a stock item is created empty, at version 0'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."warehouse_id" IS DISTINCT FROM OLD."warehouse_id"
       OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    THEN
      RAISE EXCEPTION 'ck_stock_item_origin_immutable: a stock item keeps its owner, warehouse and product'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."on_hand_quantity", NEW."reserved_quantity") IS DISTINCT FROM
       (OLD."on_hand_quantity", OLD."reserved_quantity") THEN
      IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'ck_stock_item_one_position: a balance moves one ledger position at a time'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."version" <> OLD."version" THEN
      RAISE EXCEPTION 'ck_stock_item_one_position: the ledger position moves only with the balance'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_stock_item_not_erasable: a stock item is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_stock_item_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_item"
  FOR EACH ROW EXECUTE FUNCTION "stock_item_guard"();

CREATE TRIGGER "tg_stock_item_no_truncate"
  BEFORE TRUNCATE ON "stock_item"
  FOR EACH STATEMENT EXECUTE FUNCTION "stock_item_guard"();

-- At commit: the balance a transaction leaves is the one its last movement states.
CREATE FUNCTION "stock_item_ledger_check"() RETURNS trigger AS $$
DECLARE
  current_row RECORD;
BEGIN
  SELECT "on_hand_quantity", "reserved_quantity", "version" INTO current_row
    FROM "stock_item" WHERE "id" = NEW."id";
  IF current_row."version" = 0 THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "stock_movement" m
     WHERE m."organization_id" = NEW."organization_id"
       AND m."stock_item_id" = NEW."id"
       AND m."item_version" = current_row."version"
       AND m."on_hand_after" = current_row."on_hand_quantity"
       AND m."reserved_after" = current_row."reserved_quantity"
  ) THEN
    RAISE EXCEPTION 'ck_stock_item_ledgered: a stock balance changed without its movement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_stock_item_ledger_check"
  AFTER UPDATE ON "stock_item"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "stock_item_ledger_check"();

-- ---- the movement ledger: append-only, and a verified chain --------------------
--
-- `ledger_entry`'s pattern (ADR-056 § 3): a movement is never updated, deleted or truncated; a
-- correction is a new ADJUSTMENT. Each movement is inserted after its stock item moved, states
-- the item's balance and position as they now are, and continues the previous position by
-- exactly its deltas. A reservation's movement agrees with the reservation: RESERVE with an
-- ACTIVE one of the same quantity, RELEASE with a RELEASED or EXPIRED one, ISSUE with a CONSUMED one.

CREATE FUNCTION "stock_movement_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_stock_movement_append_only: the stock ledger is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_stock_movement_append_only"
  BEFORE UPDATE OR DELETE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION "stock_movement_append_only"();

CREATE TRIGGER "tg_stock_movement_no_truncate"
  BEFORE TRUNCATE ON "stock_movement"
  FOR EACH STATEMENT EXECUTE FUNCTION "stock_movement_append_only"();

CREATE FUNCTION "stock_movement_chain"() RETURNS trigger AS $$
DECLARE
  item RECORD;
  previous RECORD;
  reservation RECORD;
BEGIN
  SELECT "on_hand_quantity", "reserved_quantity", "version" INTO item
    FROM "stock_item"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."stock_item_id";
  IF NOT FOUND
     OR item."version" <> NEW."item_version"
     OR item."on_hand_quantity" <> NEW."on_hand_after"
     OR item."reserved_quantity" <> NEW."reserved_after" THEN
    RAISE EXCEPTION 'ck_stock_movement_matches_item: a movement states the balance its stock item now holds'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."item_version" = 1 THEN
    IF NEW."on_hand_after" <> NEW."on_hand_delta" OR NEW."reserved_after" <> NEW."reserved_delta" THEN
      RAISE EXCEPTION 'ck_stock_movement_chain: the first movement starts from an empty item'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT "on_hand_after", "reserved_after" INTO previous
      FROM "stock_movement"
     WHERE "organization_id" = NEW."organization_id"
       AND "stock_item_id" = NEW."stock_item_id"
       AND "item_version" = NEW."item_version" - 1;
    IF NOT FOUND
       OR previous."on_hand_after" + NEW."on_hand_delta" <> NEW."on_hand_after"
       OR previous."reserved_after" + NEW."reserved_delta" <> NEW."reserved_after" THEN
      RAISE EXCEPTION 'ck_stock_movement_chain: a movement continues the previous one by its deltas'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."reservation_id" IS NOT NULL THEN
    SELECT "quantity", "status" INTO reservation
      FROM "stock_reservation"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."reservation_id";
    IF NOT FOUND
       OR (NEW."type" = 'RESERVE'
           AND (reservation."status" <> 'ACTIVE' OR NEW."reserved_delta" <> reservation."quantity"))
       OR (NEW."type" = 'RELEASE'
           AND (reservation."status" NOT IN ('RELEASED', 'EXPIRED')
                OR NEW."reserved_delta" <> -reservation."quantity"))
       OR (NEW."type" = 'ISSUE'
           AND (reservation."status" <> 'CONSUMED' OR NEW."on_hand_delta" <> -reservation."quantity"))
    THEN
      RAISE EXCEPTION 'ck_stock_movement_reservation: a reservation''s movement agrees with the reservation'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_stock_movement_chain"
  BEFORE INSERT ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION "stock_movement_chain"();

-- ---- a reservation: ACTIVE, then ended once ------------------------------------

CREATE FUNCTION "stock_reservation_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'ck_stock_reservation_born_active: a reservation is created ACTIVE'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."warehouse_id" IS DISTINCT FROM OLD."warehouse_id"
       OR NEW."stock_item_id" IS DISTINCT FROM OLD."stock_item_id"
       OR NEW."holder_organization_id" IS DISTINCT FROM OLD."holder_organization_id"
       OR NEW."order_reference" IS DISTINCT FROM OLD."order_reference"
       OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
       OR NEW."command_key_hash" IS DISTINCT FROM OLD."command_key_hash"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_stock_reservation_terms_immutable: what was reserved never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'ck_stock_reservation_final: an ended reservation never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" NOT IN ('CONSUMED', 'RELEASED', 'EXPIRED') OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_stock_reservation_transition: an ACTIVE reservation is consumed, released or expired, once'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_stock_reservation_not_erasable: a reservation is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_stock_reservation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_reservation"
  FOR EACH ROW EXECUTE FUNCTION "stock_reservation_guard"();

CREATE TRIGGER "tg_stock_reservation_no_truncate"
  BEFORE TRUNCATE ON "stock_reservation"
  FOR EACH STATEMENT EXECUTE FUNCTION "stock_reservation_guard"();

-- At commit: a reservation has its RESERVE movement, and an ended one its RELEASE or ISSUE, so
-- the stock item's reserved balance is exactly the sum of its ACTIVE reservations.
CREATE FUNCTION "stock_reservation_ledger_check"() RETURNS trigger AS $$
DECLARE
  current_status "StockReservationStatus";
BEGIN
  SELECT "status" INTO current_status FROM "stock_reservation" WHERE "id" = NEW."id";
  IF NOT EXISTS (
    SELECT 1 FROM "stock_movement"
     WHERE "organization_id" = NEW."organization_id"
       AND "reservation_id" = NEW."id" AND "type" = 'RESERVE'
  ) OR (current_status <> 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM "stock_movement"
     WHERE "organization_id" = NEW."organization_id"
       AND "reservation_id" = NEW."id" AND "type" IN ('RELEASE', 'ISSUE')
  )) THEN
    RAISE EXCEPTION 'ck_stock_reservation_ledgered: a reservation moved without its movement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_stock_reservation_ledger_check"
  AFTER INSERT OR UPDATE ON "stock_reservation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "stock_reservation_ledger_check"();

-- =============================================================================
-- Transactional outbox — the claim and stream objects Prisma cannot declare
-- (contract-service's initial migration, verbatim)
-- =============================================================================

-- ---- ADR-050 CHECK constraints ----------------------------------------------

-- An active claim carries all three parts or none. Two of three describes a row
-- that has no fence, or no expiry, or looks unowned to the metrics while
-- somebody is publishing it.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_triple"
  CHECK (num_nonnulls("claim_token", "claim_owner", "claim_expires_at") IN (0, 3));

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_count_nonneg"
  CHECK ("claim_count" >= 0);

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_attempts_nonneg"
  CHECK ("attempts" >= 0);

-- A published row holds no claim metadata and no scheduled retry. This is also
-- what makes `purgePublished` safe: it can never delete a row some worker still
-- holds a live lease on.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_published_is_clean"
  CHECK ("published_at" IS NULL
         OR ("claim_token" IS NULL AND "claim_owner" IS NULL
             AND "claim_expires_at" IS NULL AND "next_attempt_at" IS NULL));

-- `next_attempt_at` only means something for an unpublished row that has
-- already failed at least once.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_next_attempt_requires_failure"
  CHECK ("next_attempt_at" IS NULL OR ("published_at" IS NULL AND "attempts" >= 1));

-- ---- ADR-050 claim indexes --------------------------------------------------

CREATE INDEX IF NOT EXISTS "ix_outbox_claimable"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_claim_expiry"
    ON "outbox_message" ("claim_expires_at")
 WHERE "published_at" IS NULL AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_next_attempt"
    ON "outbox_message" ("next_attempt_at")
 WHERE "published_at" IS NULL AND "next_attempt_at" IS NOT NULL;

-- ---- ADR-050 eligibility-stream indexes -------------------------------------
--
-- The four streams `claimPendingSql` selects from. `now()` is stable rather
-- than immutable, so the planner cannot estimate `<= now()` and falls back to
-- 33% selectivity; these remove the estimate from the decision by making each
-- stream's eligibility test either statically true or a range on that index's
-- own leading column.

CREATE INDEX IF NOT EXISTS "ix_outbox_due_fresh"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_lease"
    ON "outbox_message" ("claim_expires_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_retry"
    ON "outbox_message" ("next_attempt_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_both"
    ON "outbox_message" ((GREATEST("claim_expires_at", "next_attempt_at")), "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "next_attempt_at" IS NOT NULL;

-- ---- ADR-051 -----------------------------------------------------------------
--
-- The partial unique index and the four head indexes, at the definitions
-- `scripts/verify-outbox-b1-lib.mjs` asserts. The head indexes stay empty:
-- `is_stream_head` is false on every row this service writes (B4 is not merged).

-- Partial on purpose: `WHERE stream_seq IS NOT NULL`. An unqualified unique
-- index on (topic, partition_key, stream_seq) would reject every second row
-- whose sequence is still NULL. That is a total write outage, and it passes an
-- existence check.
--
-- Not declared in schema.prisma: Prisma has no syntax for an index predicate.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_outbox_stream_seq"
    ON "outbox_message" ("topic", "partition_key", "stream_seq")
 WHERE "stream_seq" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_head_fresh"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_lease"
    ON "outbox_message" ("claim_expires_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_retry"
    ON "outbox_message" ("next_attempt_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NOT NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_both"
    ON "outbox_message" ((GREATEST("claim_expires_at", "next_attempt_at")), "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "next_attempt_at" IS NOT NULL
   AND "is_stream_head";
