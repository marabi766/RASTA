-- =============================================================================
-- inventory-service — return shipments and their tracking (RUN-005 PR 2, ADR-048 § 2, § 3).
--
-- A return shipment is the physical movement of goods BACK to one of the platform's warehouses:
-- the physical half of reverse logistics, which ADR-048 gives to inventory-and-logistics.
-- The commercial half — the return request, whether it is allowed, who decides — is
-- marketplace's, and this service never reads it: it records what happened to the goods and
-- publishes it; marketplace checks every such fact against its own request before acting on it
-- (ADR-061 § 2–3). Nothing here moves money, and nothing here makes the goods stock: a return
-- shipment moves no balance (ADR-048 § 4 — returned goods are not sellable until inspection ends).
--
-- `organization_id` is the owner of the DESTINATION warehouse on all three tables, pinned by a
-- composite foreign key (a return arrives in its owner's warehouse and no other). Q-133, temporary
-- decision: the destination is a warehouse of the order's supplier. `buyer_organization_id` is the
-- sender: an opaque organization id, never resolved here, which may read the shipment and never
-- moves it. `return_request_id` and `order_id` are opaque references into marketplace.
--
-- The lifecycle of this version is IN_TRANSIT → RECEIVED, once each, and nothing else. The
-- database keeps it, and keeps the status and its tracking history in step. INSPECTED and RESOLVED
-- widen it in the next migration (a CHECK, not an enum, so they can). Every instant is
-- TIMESTAMPTZ(3) (D-048).
-- =============================================================================

-- CreateTable
CREATE TABLE "return_shipment" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "destination_warehouse_id" TEXT NOT NULL,
    "buyer_organization_id" TEXT NOT NULL,
    "return_request_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "carrier_name" TEXT,
    "carrier_reference" TEXT,
    "line_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_TRANSIT',
    "command_key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3),
    "received_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "return_shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_shipment_line" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_shipment_id" TEXT NOT NULL,
    "order_line_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "expected_quantity" INTEGER NOT NULL,
    "received_quantity" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_shipment_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_tracking_event" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_shipment_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shipment_version" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "command_key_hash" TEXT NOT NULL,

    CONSTRAINT "return_tracking_event_pkey" PRIMARY KEY ("id")
);

-- ---- keys and indexes -------------------------------------------------------

-- The target of the children's composite foreign keys: (organization_id, …) first.
CREATE UNIQUE INDEX "ux_return_shipment_org_id" ON "return_shipment"("organization_id", "id");

-- The database backstop of the Idempotency-Key: a command's key, hashed with its route, creates at
-- most one shipment and records at most one tracking event — even after the key's own record has
-- expired. The raw key is never stored here (S-09).
CREATE UNIQUE INDEX "ux_return_shipment_command" ON "return_shipment"("organization_id", "command_key_hash");
CREATE UNIQUE INDEX "ux_return_tracking_event_command" ON "return_tracking_event"("organization_id", "command_key_hash");

-- One physical shipment per return request in one warehouse owner's books (Q-133: a return comes
-- back in one consignment). A second dispatch for the same return is the same fact again.
CREATE UNIQUE INDEX "ux_return_shipment_request" ON "return_shipment"("organization_id", "return_request_id");

-- An order line appears once in a shipment.
CREATE UNIQUE INDEX "ux_return_shipment_line_order_line" ON "return_shipment_line"("organization_id", "return_shipment_id", "order_line_id");

-- A tracking event's place in its shipment's lifecycle: the shipment version it records (1, 2 — the
-- event's `returnShipmentVersion` and its stream's `streamSeq`), given under the shipment's row
-- lock. The history reads in this order, never by time or id.
CREATE UNIQUE INDEX "ux_return_tracking_event_sequence" ON "return_tracking_event"("organization_id", "return_shipment_id", "shipment_version");

-- Reads.
CREATE INDEX "ix_return_shipment_org_status" ON "return_shipment"("organization_id", "status", "id");

-- The sender's read: return shipments sent **by** an organization, which owns none of them. A
-- counterparty index, by necessity not led by the owner's organization_id
-- (`scripts/check-tenant-index-order-lib.mjs` names it and why).
CREATE INDEX "ix_return_shipment_buyer" ON "return_shipment"("buyer_organization_id", "id");

-- ---- foreign keys: always through the owner ---------------------------------

ALTER TABLE "return_shipment" ADD CONSTRAINT "fk_return_shipment_destination_warehouse"
  FOREIGN KEY ("organization_id", "destination_warehouse_id") REFERENCES "warehouse"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "return_shipment_line" ADD CONSTRAINT "fk_return_shipment_line_shipment"
  FOREIGN KEY ("organization_id", "return_shipment_id") REFERENCES "return_shipment"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "return_tracking_event" ADD CONSTRAINT "fk_return_tracking_event_shipment"
  FOREIGN KEY ("organization_id", "return_shipment_id") REFERENCES "return_shipment"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- ---- return_shipment ----------------------------------------------------------

ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_id"
  CHECK ("id" ~ '^RSP_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_references"
  CHECK ("return_request_id" ~ '^RET_[0-9A-HJKMNP-TV-Z]{26}$'
         AND "order_id" ~ '^ORD_[0-9A-HJKMNP-TV-Z]{26}$');

-- An organization identifier of the platform's form, never resolved here. Nobody returns goods to
-- themselves.
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_buyer"
  CHECK ("buyer_organization_id" ~ '^ORG(_[0-9A-HJKMNP-TV-Z]{26}|-[A-Z0-9-]{1,48})$'
         AND "buyer_organization_id" <> "organization_id");

-- The two states of this version. A CHECK, not an enum, so a decided state can widen it reversibly.
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_status"
  CHECK ("status" IN ('IN_TRANSIT', 'RECEIVED'));

ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_command_key_hash"
  CHECK ("command_key_hash" ~ '^[0-9a-f]{64}$');

-- Free text shown to the shipment's readers, trimmed and bounded; never on an event.
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_carrier"
  CHECK (("carrier_name" IS NULL OR ("carrier_name" = btrim("carrier_name") AND char_length("carrier_name") BETWEEN 1 AND 200))
         AND ("carrier_reference" IS NULL
              OR ("carrier_reference" = btrim("carrier_reference") AND char_length("carrier_reference") BETWEEN 1 AND 100))
         AND ("carrier_reference" IS NULL OR "carrier_name" IS NOT NULL));

-- A return shipment carries at least one line; how many is fixed when it is created.
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_line_count_positive"
  CHECK ("line_count" >= 1);

-- Each status says when it was reached and by whom, and no later one is.
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_status_coherent"
  CHECK (
    (("status" = 'IN_TRANSIT' AND "received_at" IS NULL)
  OR ("status" = 'RECEIVED'   AND "received_at" IS NOT NULL))
    AND ("received_at" IS NULL) = ("received_by" IS NULL)
  );

-- `version` is the shipment's position in its own history: one per status reached.
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_version_matches_status"
  CHECK ("version" = CASE "status" WHEN 'IN_TRANSIT' THEN 1 ELSE 2 END);

ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("created_correlation_id") <> ''
         AND ("received_by" IS NULL OR btrim("received_by") <> ''));

ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_timestamps_ordered"
  CHECK ("updated_at" >= "created_at"
         AND ("received_at" IS NULL OR "received_at" >= "created_at"));

-- ---- return_shipment_line -----------------------------------------------------

ALTER TABLE "return_shipment_line" ADD CONSTRAINT "ck_return_shipment_line_id"
  CHECK ("id" ~ '^RSL_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "return_shipment_line" ADD CONSTRAINT "ck_return_shipment_line_quantities"
  CHECK ("expected_quantity" >= 1
         AND ("received_quantity" IS NULL
              OR ("received_quantity" >= 0 AND "received_quantity" <= "expected_quantity")));

-- ---- return_tracking_event ----------------------------------------------------

ALTER TABLE "return_tracking_event" ADD CONSTRAINT "ck_return_tracking_event_id"
  CHECK ("id" ~ '^RTK_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "return_tracking_event" ADD CONSTRAINT "ck_return_tracking_event_type"
  CHECK ("type" IN ('IN_TRANSIT', 'RECEIVED'));

-- What happened cannot have happened after it was recorded.
ALTER TABLE "return_tracking_event" ADD CONSTRAINT "ck_return_tracking_event_occurred_before_recorded"
  CHECK ("occurred_at" <= "recorded_at");

ALTER TABLE "return_tracking_event" ADD CONSTRAINT "ck_return_tracking_event_command_key_hash"
  CHECK ("command_key_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "return_tracking_event" ADD CONSTRAINT "ck_return_tracking_event_actor_recorded"
  CHECK (btrim("recorded_by") <> '' AND btrim("correlation_id") <> '');

-- =============================================================================
-- Triggers. The runtime role owns nothing and can disable none of them (D-045).
-- =============================================================================

-- ---- a return shipment: born IN_TRANSIT, then received — once each -------------

CREATE FUNCTION "return_shipment_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'IN_TRANSIT' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'ck_return_shipment_born_in_transit: a return shipment is created IN_TRANSIT, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."destination_warehouse_id" IS DISTINCT FROM OLD."destination_warehouse_id"
       OR NEW."buyer_organization_id" IS DISTINCT FROM OLD."buyer_organization_id"
       OR NEW."return_request_id" IS DISTINCT FROM OLD."return_request_id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."carrier_name" IS DISTINCT FROM OLD."carrier_name"
       OR NEW."carrier_reference" IS DISTINCT FROM OLD."carrier_reference"
       OR NEW."line_count" IS DISTINCT FROM OLD."line_count"
       OR NEW."command_key_hash" IS DISTINCT FROM OLD."command_key_hash"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
       OR (OLD."received_at" IS NOT NULL
           AND (NEW."received_at" IS DISTINCT FROM OLD."received_at"
                OR NEW."received_by" IS DISTINCT FROM OLD."received_by"))
    THEN
      RAISE EXCEPTION 'ck_return_shipment_terms_immutable: where a return comes from, goes to and what it was never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD."status" = 'IN_TRANSIT' AND NEW."status" = 'RECEIVED')
       OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_return_shipment_transition: a return shipment is received once, from IN_TRANSIT'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_shipment_not_erasable: a return shipment is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_shipment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "return_shipment"
  FOR EACH ROW EXECUTE FUNCTION "return_shipment_guard"();

CREATE TRIGGER "tg_return_shipment_no_truncate"
  BEFORE TRUNCATE ON "return_shipment"
  FOR EACH STATEMENT EXECUTE FUNCTION "return_shipment_guard"();

-- At commit: a shipment's status has its tracking event and its place in the history, it has lines,
-- and its lines say the same as its status — none received while IN_TRANSIT, every one once
-- RECEIVED — so its status, its history and its lines cannot tell different stories.
CREATE FUNCTION "return_shipment_history_check"() RETURNS trigger AS $$
DECLARE
  current_row RECORD;
  lines RECORD;
  events INTEGER;
BEGIN
  SELECT "status", "version", "line_count" INTO current_row FROM "return_shipment" WHERE "id" = NEW."id";
  SELECT count(*) INTO events FROM "return_tracking_event"
   WHERE "organization_id" = NEW."organization_id" AND "return_shipment_id" = NEW."id";
  IF events <> current_row."version" OR NOT EXISTS (
    SELECT 1 FROM "return_tracking_event"
     WHERE "organization_id" = NEW."organization_id" AND "return_shipment_id" = NEW."id"
       AND "shipment_version" = current_row."version" AND "type" = current_row."status"
  ) THEN
    RAISE EXCEPTION 'ck_return_shipment_tracked: a return shipment reached a status without its tracking event'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) AS "total", count("received_quantity") AS "received" INTO lines
    FROM "return_shipment_line"
   WHERE "organization_id" = NEW."organization_id" AND "return_shipment_id" = NEW."id";
  IF lines."total" <> current_row."line_count" THEN
    RAISE EXCEPTION 'ck_return_shipment_lines_complete: a return shipment has every line it was created with'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (current_row."status" = 'IN_TRANSIT' AND lines."received" <> 0)
     OR (current_row."status" = 'RECEIVED' AND lines."received" <> lines."total") THEN
    RAISE EXCEPTION 'ck_return_shipment_lines_agree: received quantities are recorded exactly when the shipment is RECEIVED, for every line'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_return_shipment_history_check"
  AFTER INSERT OR UPDATE ON "return_shipment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "return_shipment_history_check"();

-- ---- a line: written with its shipment; its receipt recorded once, with the shipment's -----
--
-- A line is inserted only while its shipment is IN_TRANSIT at version 1 and has fewer lines than it
-- was created with, with nothing received: once the creating transaction wrote them all, no later
-- one can add a line. It changes exactly once: its received quantity is set, while the shipment is RECEIVED, from
-- nothing to a number within what was expected — everything else about it stays.

CREATE FUNCTION "return_shipment_line_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  written INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "version", "line_count" INTO parent
      FROM "return_shipment"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."return_shipment_id";
    SELECT count(*) INTO written
      FROM "return_shipment_line"
     WHERE "organization_id" = NEW."organization_id" AND "return_shipment_id" = NEW."return_shipment_id";
    IF NOT FOUND OR parent."status" <> 'IN_TRANSIT' OR parent."version" <> 1
       OR written >= parent."line_count" OR NEW."received_quantity" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_return_shipment_line_with_shipment: lines are written with their shipment, while it is IN_TRANSIT, unreceived'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT "status" INTO parent
      FROM "return_shipment"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."return_shipment_id";
    IF NOT FOUND OR parent."status" <> 'RECEIVED'
       OR OLD."received_quantity" IS NOT NULL OR NEW."received_quantity" IS NULL
       OR NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."return_shipment_id" IS DISTINCT FROM OLD."return_shipment_id"
       OR NEW."order_line_id" IS DISTINCT FROM OLD."order_line_id"
       OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
       OR NEW."expected_quantity" IS DISTINCT FROM OLD."expected_quantity"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'ck_return_shipment_line_received_once: a line''s received quantity is set once, as its shipment is received'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_shipment_line_immutable: a return shipment line is never erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_shipment_line_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "return_shipment_line"
  FOR EACH ROW EXECUTE FUNCTION "return_shipment_line_guard"();

CREATE TRIGGER "tg_return_shipment_line_no_truncate"
  BEFORE TRUNCATE ON "return_shipment_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "return_shipment_line_guard"();

-- ---- tracking history: append-only, in order, and the status it records -------
--
-- An event is inserted after its shipment reached the status it records, carrying the version that
-- status gave the shipment, and never before an earlier event of the same shipment.

CREATE FUNCTION "return_tracking_event_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  latest TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "version" INTO parent
      FROM "return_shipment"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."return_shipment_id";
    IF NOT FOUND OR parent."status" <> NEW."type" OR parent."version" <> NEW."shipment_version" THEN
      RAISE EXCEPTION 'ck_return_tracking_event_matches_shipment: a tracking event records the status and version its return shipment now has'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT max("occurred_at") INTO latest
      FROM "return_tracking_event"
     WHERE "organization_id" = NEW."organization_id" AND "return_shipment_id" = NEW."return_shipment_id";
    IF latest IS NOT NULL AND NEW."occurred_at" < latest THEN
      RAISE EXCEPTION 'ck_return_tracking_event_in_order: a tracking event never precedes an earlier one'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_tracking_event_append_only: tracking history is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_tracking_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "return_tracking_event"
  FOR EACH ROW EXECUTE FUNCTION "return_tracking_event_guard"();

CREATE TRIGGER "tg_return_tracking_event_no_truncate"
  BEFORE TRUNCATE ON "return_tracking_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "return_tracking_event_guard"();
