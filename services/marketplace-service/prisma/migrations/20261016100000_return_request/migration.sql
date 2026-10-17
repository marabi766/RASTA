-- =============================================================================
-- marketplace-service — the return request (RUN-005, ADR-048 § 2, § 3).
--
-- A return request is the buyer's commercial request to send back goods of a COMPLETED order,
-- and the supplier's decision about it. It is marketplace's half of reverse logistics; the
-- physical half (the return shipment, its receipt, inspection and disposition) is
-- inventory-service's, and every Hold, Refund and Reversal is economic-service's. Nothing here
-- moves money, stock or a file.
--
-- ADR-048 § 3 plans REQUESTED → AUTHORIZED → IN_TRANSIT → RECEIVED → INSPECTED → RESOLVED, with
-- REJECTED or CANCELLED before RESOLVED. This version stores the first half of it: a request is
-- REQUESTED, then AUTHORIZED, REJECTED or CANCELLED — once. The status is a CHECK, not an enum,
-- so the physical states (set by inventory-service's events, the next PR) widen it reversibly.
-- The database keeps the lifecycle: the trigger below refuses every other move, whatever a
-- future write path forgets.
--
-- `organization_id` is the BUYER, the tenant that owns the request, as on "order". The supplier
-- (`supplier_organization_id`) is a plain column — it reads and decides across the tenant guard
-- with a written reason, in access.ts (Order's precedent, ADR-037 § 8).
-- Every instant is TIMESTAMPTZ(3) (D-048).
-- =============================================================================
SET LOCAL lock_timeout = '3s';

-- CreateTable
CREATE TABLE "return_request" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "supplier_organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "command_key_hash" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_correlation_id" TEXT NOT NULL,
    "authorized_at" TIMESTAMPTZ(3),
    "authorized_by" TEXT,
    "rejected_at" TIMESTAMPTZ(3),
    "rejected_by" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" TEXT,
    "cancelled_from" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_line" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_request_id" TEXT NOT NULL,
    "order_line_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_status_history" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_request_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "actor_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "command_key_hash" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_status_history_pkey" PRIMARY KEY ("id")
);

-- ---- keys and indexes -------------------------------------------------------

-- The target of the children's composite foreign keys: (organization_id, …) first.
CREATE UNIQUE INDEX "ux_return_request_org_id" ON "return_request"("organization_id", "id");

-- The database backstop of the Idempotency-Key: a command's key, hashed with its route, creates
-- at most one request and records at most one history row — even after the key's own record has
-- expired. The raw key is never stored here (S-09).
CREATE UNIQUE INDEX "ux_return_request_command" ON "return_request"("organization_id", "command_key_hash");
CREATE UNIQUE INDEX "ux_return_history_command" ON "return_status_history"("organization_id", "command_key_hash");

-- A request's history has one row per version: its place in its own lifecycle.
CREATE UNIQUE INDEX "ux_return_history_version" ON "return_status_history"("organization_id", "return_request_id", "version");

-- An order line appears once in a request.
CREATE UNIQUE INDEX "ux_return_line_order_line" ON "return_line"("organization_id", "return_request_id", "order_line_id");

-- Reads.
CREATE INDEX "ix_return_request_org_status" ON "return_request"("organization_id", "status", "id");
CREATE INDEX "ix_return_request_order" ON "return_request"("organization_id", "order_id", "id");
CREATE INDEX "ix_return_line_order_line" ON "return_line"("order_line_id");

-- The supplier's own requests (GET /v1/returns?role=SUPPLIER): a request belongs to the buyer,
-- but the supplier asking is another tenant (`scripts/check-tenant-index-order-lib.mjs` names it).
CREATE INDEX "ix_return_request_supplier" ON "return_request"("supplier_organization_id", "id");

-- ---- foreign keys: always through the owner ---------------------------------

ALTER TABLE "return_request" ADD CONSTRAINT "fk_return_request_order"
  FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "return_line" ADD CONSTRAINT "fk_return_line_request"
  FOREIGN KEY ("organization_id", "return_request_id") REFERENCES "return_request"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "return_line" ADD CONSTRAINT "fk_return_line_order_line"
  FOREIGN KEY ("order_line_id") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "return_status_history" ADD CONSTRAINT "fk_return_history_request"
  FOREIGN KEY ("organization_id", "return_request_id") REFERENCES "return_request"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps
-- =============================================================================

-- ---- return_request -------------------------------------------------------------

ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_id"
  CHECK ("id" ~ '^RET_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_order_id"
  CHECK ("order_id" ~ '^ORD_[0-9A-HJKMNP-TV-Z]{26}$');

-- The buyer and the seller are different organizations: nobody returns goods to themselves.
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_parties"
  CHECK ("organization_id" <> "supplier_organization_id");

-- The four states of this version. A CHECK, not an enum: the physical states widen it.
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_status"
  CHECK ("status" IN ('REQUESTED', 'AUTHORIZED', 'REJECTED', 'CANCELLED'));

-- Free text shown to the supplier, trimmed and bounded; never on an event.
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_reason"
  CHECK ("reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 1000);

ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_command_key_hash"
  CHECK ("command_key_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_cancelled_from"
  CHECK ("cancelled_from" IS NULL OR "cancelled_from" IN ('REQUESTED', 'AUTHORIZED'));

-- Each status says when it was reached and by whom, and no other decision is on the row. A
-- cancellation says where it left from, and that agrees with whether it had been authorized.
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_status_coherent"
  CHECK (
    (("status" = 'REQUESTED'
        AND "authorized_at" IS NULL AND "rejected_at" IS NULL AND "cancelled_at" IS NULL
        AND "cancelled_from" IS NULL)
  OR ("status" = 'AUTHORIZED'
        AND "authorized_at" IS NOT NULL AND "rejected_at" IS NULL AND "cancelled_at" IS NULL
        AND "cancelled_from" IS NULL)
  OR ("status" = 'REJECTED'
        AND "authorized_at" IS NULL AND "rejected_at" IS NOT NULL AND "cancelled_at" IS NULL
        AND "cancelled_from" IS NULL)
  OR ("status" = 'CANCELLED'
        AND "rejected_at" IS NULL AND "cancelled_at" IS NOT NULL
        AND (("cancelled_from" = 'REQUESTED'  AND "authorized_at" IS NULL)
          OR ("cancelled_from" = 'AUTHORIZED' AND "authorized_at" IS NOT NULL))))
    AND ("authorized_at" IS NULL) = ("authorized_by" IS NULL)
    AND ("rejected_at"   IS NULL) = ("rejected_by"   IS NULL)
    AND ("cancelled_at"  IS NULL) = ("cancelled_by"  IS NULL)
  );

-- `version` is the request's position in its own history: one per status reached.
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_version_matches_status"
  CHECK ("version" = CASE "status"
                       WHEN 'REQUESTED' THEN 1
                       WHEN 'AUTHORIZED' THEN 2
                       WHEN 'REJECTED' THEN 2
                       ELSE CASE "cancelled_from" WHEN 'REQUESTED' THEN 2 ELSE 3 END
                     END);

ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_actor_recorded"
  CHECK (btrim("requested_by") <> '' AND btrim("requested_correlation_id") <> ''
         AND ("authorized_by" IS NULL OR btrim("authorized_by") <> '')
         AND ("rejected_by" IS NULL OR btrim("rejected_by") <> '')
         AND ("cancelled_by" IS NULL OR btrim("cancelled_by") <> ''));

ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_timestamps_ordered"
  CHECK ("updated_at" >= "requested_at"
         AND ("authorized_at" IS NULL OR "authorized_at" >= "requested_at")
         AND ("rejected_at" IS NULL OR "rejected_at" >= "requested_at")
         AND ("cancelled_at" IS NULL OR "cancelled_at" >= COALESCE("authorized_at", "requested_at")));

-- ---- return_line ----------------------------------------------------------------

ALTER TABLE "return_line" ADD CONSTRAINT "ck_return_line_id"
  CHECK ("id" ~ '^RTL_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "return_line" ADD CONSTRAINT "ck_return_line_quantity_positive"
  CHECK ("quantity" >= 1);

-- ---- return_status_history ------------------------------------------------------

ALTER TABLE "return_status_history" ADD CONSTRAINT "ck_return_history_id"
  CHECK ("id" ~ '^RSH_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "return_status_history" ADD CONSTRAINT "ck_return_history_status"
  CHECK ("to_status" IN ('REQUESTED', 'AUTHORIZED', 'REJECTED', 'CANCELLED')
         AND ("from_status" IS NULL OR "from_status" IN ('REQUESTED', 'AUTHORIZED'))
         AND (("from_status" IS NULL) = ("version" = 1))
         AND ("to_status" = 'REQUESTED') = ("version" = 1));

ALTER TABLE "return_status_history" ADD CONSTRAINT "ck_return_history_command_key_hash"
  CHECK ("command_key_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "return_status_history" ADD CONSTRAINT "ck_return_history_actor_recorded"
  CHECK (btrim("actor_id") <> '' AND btrim("correlation_id") <> '');

-- =============================================================================
-- Triggers. The runtime role owns nothing and can disable none of them (D-045).
-- =============================================================================

-- ---- a request: born REQUESTED, then decided or withdrawn — once ----------------

CREATE FUNCTION "return_request_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'ck_return_request_born_requested: a return request is created REQUESTED, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A request is its order's and its buyer's: the tenant and the seller are the order's own.
    SELECT "organization_id", "supplier_organization_id" INTO parent
      FROM "order" WHERE "id" = NEW."order_id";
    IF NOT FOUND
       OR parent."organization_id" <> NEW."organization_id"
       OR parent."supplier_organization_id" <> NEW."supplier_organization_id" THEN
      RAISE EXCEPTION 'ck_return_request_parties_of_order: a return request names its order''s own buyer and seller'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."supplier_organization_id" IS DISTINCT FROM OLD."supplier_organization_id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."command_key_hash" IS DISTINCT FROM OLD."command_key_hash"
       OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
       OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
       OR NEW."requested_correlation_id" IS DISTINCT FROM OLD."requested_correlation_id"
       OR (OLD."authorized_at" IS NOT NULL
           AND (NEW."authorized_at" IS DISTINCT FROM OLD."authorized_at"
                OR NEW."authorized_by" IS DISTINCT FROM OLD."authorized_by"))
    THEN
      RAISE EXCEPTION 'ck_return_request_terms_immutable: what was asked, of which order and by whom never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((OLD."status" = 'REQUESTED' AND NEW."status" IN ('AUTHORIZED', 'REJECTED', 'CANCELLED'))
            OR (OLD."status" = 'AUTHORIZED' AND NEW."status" = 'CANCELLED'))
       OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_return_request_transition: a request is authorized, rejected or cancelled from REQUESTED, or cancelled from AUTHORIZED'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_request_not_erasable: a return request is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_request_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "return_request"
  FOR EACH ROW EXECUTE FUNCTION "return_request_guard"();

CREATE TRIGGER "tg_return_request_no_truncate"
  BEFORE TRUNCATE ON "return_request"
  FOR EACH STATEMENT EXECUTE FUNCTION "return_request_guard"();

-- At commit: a request's status has its history row, the history has exactly one row per version,
-- and a request has at least one line — so its status, its history and its lines cannot tell
-- different stories.
CREATE FUNCTION "return_request_history_check"() RETURNS trigger AS $$
DECLARE
  current_row RECORD;
  written INTEGER;
BEGIN
  SELECT "status", "version" INTO current_row FROM "return_request" WHERE "id" = NEW."id";
  SELECT count(*) INTO written FROM "return_status_history"
   WHERE "organization_id" = NEW."organization_id" AND "return_request_id" = NEW."id";
  IF written <> current_row."version" OR NOT EXISTS (
    SELECT 1 FROM "return_status_history"
     WHERE "organization_id" = NEW."organization_id" AND "return_request_id" = NEW."id"
       AND "version" = current_row."version" AND "to_status" = current_row."status"
  ) THEN
    RAISE EXCEPTION 'ck_return_request_tracked: a request reached a status without its history row'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "return_line"
     WHERE "organization_id" = NEW."organization_id" AND "return_request_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'ck_return_request_has_lines: a return request returns at least one order line'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_return_request_history_check"
  AFTER INSERT OR UPDATE ON "return_request"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "return_request_history_check"();

-- ---- a line: written with its request, within what the order sold ----------------
--
-- A line is inserted only while its request is REQUESTED at version 1, names a line of the
-- request's own order and that line's own product, and — under the order line's row lock, so two
-- requests cannot both take the last unit — never takes the order line past the quantity it was
-- sold for, counting every request that is not REJECTED or CANCELLED.

CREATE FUNCTION "return_line_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  sold RECORD;
  taken BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "version", "order_id" INTO parent
      FROM "return_request"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."return_request_id";
    IF NOT FOUND OR parent."status" <> 'REQUESTED' OR parent."version" <> 1 THEN
      RAISE EXCEPTION 'ck_return_line_with_request: lines are written with their request, while it is REQUESTED'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "order_id", "organization_id", "product_id", "quantity" INTO sold
      FROM "order_line" WHERE "id" = NEW."order_line_id" FOR UPDATE;
    IF NOT FOUND
       OR sold."order_id" <> parent."order_id"
       OR sold."organization_id" <> NEW."organization_id"
       OR sold."product_id" <> NEW."product_id" THEN
      RAISE EXCEPTION 'ck_return_line_of_order: a return line is a line of the request''s own order'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(sum(l."quantity"), 0) INTO taken
      FROM "return_line" l
      JOIN "return_request" r ON r."id" = l."return_request_id"
     WHERE l."order_line_id" = NEW."order_line_id" AND r."status" IN ('REQUESTED', 'AUTHORIZED');
    IF taken + NEW."quantity" > sold."quantity" THEN
      RAISE EXCEPTION 'ck_return_line_within_sold: more would be returned than the order line sold'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_line_immutable: a return line is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_line_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "return_line"
  FOR EACH ROW EXECUTE FUNCTION "return_line_guard"();

CREATE TRIGGER "tg_return_line_no_truncate"
  BEFORE TRUNCATE ON "return_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "return_line_guard"();

-- ---- history: append-only, in order, and the status it records -------------------

CREATE FUNCTION "return_status_history_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  latest TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "version" INTO parent
      FROM "return_request"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."return_request_id";
    IF NOT FOUND OR parent."status" <> NEW."to_status" OR parent."version" <> NEW."version" THEN
      RAISE EXCEPTION 'ck_return_history_matches_request: a history row records the status and version its request now has'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT max("occurred_at") INTO latest
      FROM "return_status_history"
     WHERE "organization_id" = NEW."organization_id" AND "return_request_id" = NEW."return_request_id";
    IF latest IS NOT NULL AND NEW."occurred_at" < latest THEN
      RAISE EXCEPTION 'ck_return_history_in_order: a history row never precedes an earlier one'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_history_append_only: a return''s history is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_status_history_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "return_status_history"
  FOR EACH ROW EXECUTE FUNCTION "return_status_history_guard"();

CREATE TRIGGER "tg_return_status_history_no_truncate"
  BEFORE TRUNCATE ON "return_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "return_status_history_guard"();
