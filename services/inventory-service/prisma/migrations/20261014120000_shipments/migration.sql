-- =============================================================================
-- inventory-service — shipments and tracking (COM-006 PR 2, ADR-056 § 2, § 5, § 6).
--
-- A shipment is the physical movement of goods out of one of the platform's
-- warehouses (ADR-056 § 2) — not marketplace's Fulfillment, which is a
-- supplier's declaration and is neither read nor written here. It has legs (the
-- carriers that move it) and an append-only tracking history.
--
-- `organization_id` is the owner of the origin warehouse on all three tables,
-- pinned by a composite foreign key: a shipment leaves its owner's warehouse
-- and no other, and its children can never point at another tenant's shipment.
-- `consignee_organization_id` is the organization it is sent to (ADR-056 § 5):
-- an opaque identifier, never resolved here (Q-113), which may read the
-- shipment and its tracking but never moves it.
--
-- The lifecycle is CREATED → DISPATCHED → DELIVERED and nothing else (Q-114);
-- the database keeps it, and keeps the status and its tracking history in step.
-- A shipment moves no stock (Q-115). Every instant is TIMESTAMPTZ(3) (D-048).
-- =============================================================================

-- CreateTable
CREATE TABLE "shipment" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "origin_warehouse_id" TEXT NOT NULL,
    "consignee_organization_id" TEXT NOT NULL,
    "order_reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "leg_count" INTEGER NOT NULL,
    "command_key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "dispatched_at" TIMESTAMPTZ(3),
    "dispatched_by" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    "delivered_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_leg" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "carrier_name" TEXT NOT NULL,
    "carrier_reference" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipment_leg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_event" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "command_key_hash" TEXT NOT NULL,

    CONSTRAINT "tracking_event_pkey" PRIMARY KEY ("id")
);

-- ---- keys and indexes -------------------------------------------------------

-- The target of the children's composite foreign keys: (organization_id, …) first.
CREATE UNIQUE INDEX "ux_shipment_org_id" ON "shipment"("organization_id", "id");

-- The database backstop of the Idempotency-Key (PR 1's deviation 1): a command's key, hashed with
-- its route, creates at most one shipment and records at most one tracking event — even after the
-- key's 24 hours in `idempotency_key` are over. The raw key is never stored here (S-09).
CREATE UNIQUE INDEX "ux_shipment_command" ON "shipment"("organization_id", "command_key_hash");
CREATE UNIQUE INDEX "ux_tracking_event_command" ON "tracking_event"("organization_id", "command_key_hash");

-- A shipment's legs are numbered once each.
CREATE UNIQUE INDEX "ux_shipment_leg_sequence" ON "shipment_leg"("organization_id", "shipment_id", "sequence");

-- A shipment is created, dispatched and delivered once each. Partial, so a repeatable type (a
-- checkpoint, Q-114) can be added without dropping it.
CREATE UNIQUE INDEX "ux_tracking_event_once" ON "tracking_event"("organization_id", "shipment_id", "type")
  WHERE "type" IN ('CREATED', 'DISPATCHED', 'DELIVERED');

-- Reads.
CREATE INDEX "ix_shipment_org_status" ON "shipment"("organization_id", "status", "id");
CREATE INDEX "ix_tracking_event_org_shipment" ON "tracking_event"("organization_id", "shipment_id", "occurred_at", "id");

-- The consignee's read (ADR-056 § 5): shipments sent **to** an organization, which owns none of
-- them. A counterparty index, by necessity not led by the owner's organization_id
-- (`scripts/check-tenant-index-order-lib.mjs` names it and why).
CREATE INDEX "ix_shipment_consignee" ON "shipment"("consignee_organization_id", "id");

-- ---- foreign keys: always through the owner ---------------------------------

ALTER TABLE "shipment" ADD CONSTRAINT "fk_shipment_origin_warehouse"
  FOREIGN KEY ("organization_id", "origin_warehouse_id") REFERENCES "warehouse"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "shipment_leg" ADD CONSTRAINT "fk_shipment_leg_shipment"
  FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "shipment"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tracking_event" ADD CONSTRAINT "fk_tracking_event_shipment"
  FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "shipment"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- ---- shipment -----------------------------------------------------------------

ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_id"
  CHECK ("id" ~ '^SHP_[0-9A-HJKMNP-TV-Z]{26}$');

-- An organization identifier of the platform's form (`ORG_<ULID>`, or a readable seed id),
-- never resolved here (Q-113).
ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_consignee"
  CHECK ("consignee_organization_id" ~ '^ORG(_[0-9A-HJKMNP-TV-Z]{26}|-[A-Z0-9-]{1,48})$');

-- An opaque reference to an order or a purchase order of another service (ADR-056 § 1).
ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_order_reference"
  CHECK ("order_reference" IS NULL OR "order_reference" ~ '^(ORD|PO)_[0-9A-HJKMNP-TV-Z]{26}$');

-- The three states of this version (Q-114). A CHECK, not an enum, so a decided state (the plan's
-- FAILED, a cancellation) can widen it reversibly.
ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_status"
  CHECK ("status" IN ('CREATED', 'DISPATCHED', 'DELIVERED'));

-- A shipment has at least one leg; how many is fixed when it is created.
ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_leg_count_positive"
  CHECK ("leg_count" >= 1);

ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_command_key_hash"
  CHECK ("command_key_hash" ~ '^[0-9a-f]{64}$');

-- Each status says when it was reached and by whom, and no later one is.
ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_status_coherent"
  CHECK (
    (("status" = 'CREATED'    AND "dispatched_at" IS NULL     AND "delivered_at" IS NULL)
  OR ("status" = 'DISPATCHED' AND "dispatched_at" IS NOT NULL AND "delivered_at" IS NULL)
  OR ("status" = 'DELIVERED'  AND "dispatched_at" IS NOT NULL AND "delivered_at" IS NOT NULL))
    AND ("dispatched_at" IS NULL) = ("dispatched_by" IS NULL)
    AND ("delivered_at" IS NULL) = ("delivered_by" IS NULL)
  );

-- `version` is the shipment's position in its own history: one per status reached.
ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_version_matches_status"
  CHECK ("version" = CASE "status" WHEN 'CREATED' THEN 1 WHEN 'DISPATCHED' THEN 2 ELSE 3 END);

ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("created_correlation_id") <> ''
         AND ("dispatched_by" IS NULL OR btrim("dispatched_by") <> '')
         AND ("delivered_by" IS NULL OR btrim("delivered_by") <> ''));

ALTER TABLE "shipment" ADD CONSTRAINT "ck_shipment_timestamps_ordered"
  CHECK ("updated_at" >= "created_at"
         AND ("dispatched_at" IS NULL OR "dispatched_at" >= "created_at")
         AND ("delivered_at" IS NULL OR "delivered_at" >= "dispatched_at"));

-- ---- shipment_leg -------------------------------------------------------------

ALTER TABLE "shipment_leg" ADD CONSTRAINT "ck_shipment_leg_id"
  CHECK ("id" ~ '^SHL_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "shipment_leg" ADD CONSTRAINT "ck_shipment_leg_sequence_positive"
  CHECK ("sequence" >= 1);

-- Free text shown to the shipment's readers, trimmed and bounded; never on an event (Q-115).
ALTER TABLE "shipment_leg" ADD CONSTRAINT "ck_shipment_leg_carrier"
  CHECK ("carrier_name" = btrim("carrier_name") AND char_length("carrier_name") BETWEEN 1 AND 200
         AND ("carrier_reference" IS NULL
              OR ("carrier_reference" = btrim("carrier_reference")
                  AND char_length("carrier_reference") BETWEEN 1 AND 100)));

-- ---- tracking_event -----------------------------------------------------------

ALTER TABLE "tracking_event" ADD CONSTRAINT "ck_tracking_event_id"
  CHECK ("id" ~ '^TRK_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "tracking_event" ADD CONSTRAINT "ck_tracking_event_type"
  CHECK ("type" IN ('CREATED', 'DISPATCHED', 'DELIVERED'));

-- What happened cannot have happened after it was recorded.
ALTER TABLE "tracking_event" ADD CONSTRAINT "ck_tracking_event_occurred_before_recorded"
  CHECK ("occurred_at" <= "recorded_at");

ALTER TABLE "tracking_event" ADD CONSTRAINT "ck_tracking_event_command_key_hash"
  CHECK ("command_key_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "tracking_event" ADD CONSTRAINT "ck_tracking_event_actor_recorded"
  CHECK (btrim("recorded_by") <> '' AND btrim("correlation_id") <> '');

-- =============================================================================
-- Triggers. The runtime role owns nothing and can disable none of them (D-045).
-- =============================================================================

-- ---- a shipment: born CREATED, then dispatched, then delivered — once each ----

CREATE FUNCTION "shipment_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'CREATED' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'ck_shipment_born_created: a shipment is created CREATED, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."origin_warehouse_id" IS DISTINCT FROM OLD."origin_warehouse_id"
       OR NEW."consignee_organization_id" IS DISTINCT FROM OLD."consignee_organization_id"
       OR NEW."order_reference" IS DISTINCT FROM OLD."order_reference"
       OR NEW."leg_count" IS DISTINCT FROM OLD."leg_count"
       OR NEW."command_key_hash" IS DISTINCT FROM OLD."command_key_hash"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
       OR (OLD."dispatched_at" IS NOT NULL
           AND (NEW."dispatched_at" IS DISTINCT FROM OLD."dispatched_at"
                OR NEW."dispatched_by" IS DISTINCT FROM OLD."dispatched_by"))
    THEN
      RAISE EXCEPTION 'ck_shipment_terms_immutable: where a shipment comes from, goes to and what it was never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((OLD."status" = 'CREATED' AND NEW."status" = 'DISPATCHED')
            OR (OLD."status" = 'DISPATCHED' AND NEW."status" = 'DELIVERED'))
       OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_shipment_transition: a shipment is dispatched, then delivered, once each'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_shipment_not_erasable: a shipment is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_shipment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "shipment"
  FOR EACH ROW EXECUTE FUNCTION "shipment_guard"();

CREATE TRIGGER "tg_shipment_no_truncate"
  BEFORE TRUNCATE ON "shipment"
  FOR EACH STATEMENT EXECUTE FUNCTION "shipment_guard"();

-- At commit: a shipment's status has its tracking event, and a new shipment has all its legs,
-- numbered 1..leg_count — so its status and its history cannot tell two stories.
CREATE FUNCTION "shipment_history_check"() RETURNS trigger AS $$
DECLARE
  current_row RECORD;
  legs RECORD;
BEGIN
  SELECT "status", "leg_count" INTO current_row FROM "shipment" WHERE "id" = NEW."id";
  IF NOT EXISTS (
    SELECT 1 FROM "tracking_event"
     WHERE "organization_id" = NEW."organization_id"
       AND "shipment_id" = NEW."id" AND "type" = current_row."status"
  ) THEN
    RAISE EXCEPTION 'ck_shipment_tracked: a shipment reached a status without its tracking event'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) AS "count", max("sequence") AS "last" INTO legs
    FROM "shipment_leg"
   WHERE "organization_id" = NEW."organization_id" AND "shipment_id" = NEW."id";
  IF legs."count" <> current_row."leg_count" OR legs."last" IS DISTINCT FROM current_row."leg_count" THEN
    RAISE EXCEPTION 'ck_shipment_legs_complete: a shipment has every leg it was created with, numbered 1..n'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_shipment_history_check"
  AFTER INSERT OR UPDATE ON "shipment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "shipment_history_check"();

-- ---- a leg: written with its shipment, in order, and never changed ------------
--
-- A leg is inserted only while its shipment has fewer legs than it was created with, as the next
-- number: once the creating transaction wrote them all, no later one can add, renumber or change a
-- leg.

CREATE FUNCTION "shipment_leg_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  written INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "leg_count" INTO parent
      FROM "shipment"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."shipment_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ck_shipment_leg_with_shipment: legs are written with their shipment, numbered in order'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO written
      FROM "shipment_leg"
     WHERE "organization_id" = NEW."organization_id" AND "shipment_id" = NEW."shipment_id";
    IF parent."status" <> 'CREATED' OR written >= parent."leg_count"
       OR NEW."sequence" <> written + 1 THEN
      RAISE EXCEPTION 'ck_shipment_leg_with_shipment: legs are written with their shipment, numbered in order'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_shipment_leg_immutable: a shipment leg is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_shipment_leg_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "shipment_leg"
  FOR EACH ROW EXECUTE FUNCTION "shipment_leg_guard"();

CREATE TRIGGER "tg_shipment_leg_no_truncate"
  BEFORE TRUNCATE ON "shipment_leg"
  FOR EACH STATEMENT EXECUTE FUNCTION "shipment_leg_guard"();

-- ---- tracking history: append-only, in order, and the status it records ------
--
-- An event is inserted after its shipment reached the status it records, and never before an
-- earlier event of the same shipment: the history reads in the order things happened.

CREATE FUNCTION "tracking_event_guard"() RETURNS trigger AS $$
DECLARE
  parent_status TEXT;
  latest TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO parent_status
      FROM "shipment"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."shipment_id";
    IF NOT FOUND OR parent_status <> NEW."type" THEN
      RAISE EXCEPTION 'ck_tracking_event_matches_shipment: a tracking event records the status its shipment now has'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT max("occurred_at") INTO latest
      FROM "tracking_event"
     WHERE "organization_id" = NEW."organization_id" AND "shipment_id" = NEW."shipment_id";
    IF latest IS NOT NULL AND NEW."occurred_at" < latest THEN
      RAISE EXCEPTION 'ck_tracking_event_in_order: a tracking event never precedes an earlier one'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_tracking_event_append_only: tracking history is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tracking_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "tracking_event"
  FOR EACH ROW EXECUTE FUNCTION "tracking_event_guard"();

CREATE TRIGGER "tg_tracking_event_no_truncate"
  BEFORE TRUNCATE ON "tracking_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "tracking_event_guard"();
