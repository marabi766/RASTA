-- =============================================================================
-- inventory-service — return inspection and disposition (RUN-005 PR 2b, ADR-048 § 3, § 4).
--
-- Extends the return shipment's physical lifecycle from IN_TRANSIT → RECEIVED to
--
--     IN_TRANSIT → RECEIVED → INSPECTED → RESOLVED
--
-- once each, and nothing else: no cancellation, no reopening (Q-133). INSPECTED records that the
-- received goods were examined — who and when, an optional note (kept here, never on an event) and
-- an optional reference to the report in document-service (files live only there). RESOLVED
-- records what becomes of every received unit: a disposition per line (ADR-048 § 1) whose
-- quantities add up to exactly what was received. Which dispositions are *allowed* is
-- configuration (INVENTORY_RETURN_DISPOSITIONS_ALLOWED, Q-133), enforced by the service; the
-- database keeps the six ADR-048 names and the arithmetic.
--
-- A disposition moves no stock and no money here: restocking is a separate, explicit act, and a
-- refund is economic's (Q-76). Returned goods stay out of the sellable balance (ADR-048 § 4).
-- Every instant is TIMESTAMPTZ(3) (D-048).
-- =============================================================================

-- ---- return_shipment: what inspection and resolution record -----------------

ALTER TABLE "return_shipment"
  ADD COLUMN "inspected_at" TIMESTAMPTZ(3),
  ADD COLUMN "inspected_by" TEXT,
  ADD COLUMN "inspection_note" TEXT,
  ADD COLUMN "inspection_report_document_id" TEXT,
  ADD COLUMN "resolved_at" TIMESTAMPTZ(3),
  ADD COLUMN "resolved_by" TEXT;

-- The four states of this version. A CHECK, not an enum, so a decided state can widen it again.
ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_status";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_status"
  CHECK ("status" IN ('IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED'));

-- Each status says when it was reached and by whom, and no later one is.
ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_status_coherent";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_status_coherent"
  CHECK (
    (("status" = 'IN_TRANSIT' AND "received_at" IS NULL AND "inspected_at" IS NULL AND "resolved_at" IS NULL)
  OR ("status" = 'RECEIVED'   AND "received_at" IS NOT NULL AND "inspected_at" IS NULL AND "resolved_at" IS NULL)
  OR ("status" = 'INSPECTED'  AND "received_at" IS NOT NULL AND "inspected_at" IS NOT NULL AND "resolved_at" IS NULL)
  OR ("status" = 'RESOLVED'   AND "received_at" IS NOT NULL AND "inspected_at" IS NOT NULL AND "resolved_at" IS NOT NULL))
    AND ("received_at" IS NULL) = ("received_by" IS NULL)
    AND ("inspected_at" IS NULL) = ("inspected_by" IS NULL)
    AND ("resolved_at" IS NULL) = ("resolved_by" IS NULL)
    AND ("inspection_note" IS NULL OR "inspected_at" IS NOT NULL)
    AND ("inspection_report_document_id" IS NULL OR "inspected_at" IS NOT NULL)
  );

-- `version` is the shipment's position in its own history: one per status reached.
ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_version_matches_status";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_version_matches_status"
  CHECK ("version" = CASE "status" WHEN 'IN_TRANSIT' THEN 1 WHEN 'RECEIVED' THEN 2 WHEN 'INSPECTED' THEN 3 ELSE 4 END);

ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_actor_recorded";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("created_correlation_id") <> ''
         AND ("received_by" IS NULL OR btrim("received_by") <> '')
         AND ("inspected_by" IS NULL OR btrim("inspected_by") <> '')
         AND ("resolved_by" IS NULL OR btrim("resolved_by") <> ''));

ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_timestamps_ordered";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_timestamps_ordered"
  CHECK ("updated_at" >= "created_at"
         AND ("received_at" IS NULL OR "received_at" >= "created_at")
         AND ("inspected_at" IS NULL OR "inspected_at" >= "received_at")
         AND ("resolved_at" IS NULL OR "resolved_at" >= "inspected_at"));

-- Free text kept here and shown to the shipment's readers: trimmed and bounded; never on an event.
-- The report is another service's file, referenced by its platform id and never resolved here.
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_inspection"
  CHECK (("inspection_note" IS NULL
          OR ("inspection_note" = btrim("inspection_note") AND char_length("inspection_note") BETWEEN 1 AND 1000))
         AND ("inspection_report_document_id" IS NULL
              OR "inspection_report_document_id" ~ '^DOC_[0-9A-HJKMNP-TV-Z]{26}$'));

ALTER TABLE "return_tracking_event" DROP CONSTRAINT "ck_return_tracking_event_type";
ALTER TABLE "return_tracking_event" ADD CONSTRAINT "ck_return_tracking_event_type"
  CHECK ("type" IN ('IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED'));

-- ---- return_disposition: what becomes of every received unit -----------------

CREATE TABLE "return_disposition" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_shipment_id" TEXT NOT NULL,
    "order_line_id" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_disposition_pkey" PRIMARY KEY ("id")
);

-- A line has one row per disposition: its quantity is the total sent that way.
CREATE UNIQUE INDEX "ux_return_disposition_line" ON "return_disposition"("organization_id", "return_shipment_id", "order_line_id", "disposition");

ALTER TABLE "return_disposition" ADD CONSTRAINT "fk_return_disposition_shipment"
  FOREIGN KEY ("organization_id", "return_shipment_id") REFERENCES "return_shipment"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "return_disposition" ADD CONSTRAINT "ck_return_disposition_id"
  CHECK ("id" ~ '^RDP_[0-9A-HJKMNP-TV-Z]{26}$');

-- The six outcomes ADR-048 § 1 names. Which of them an organization may choose is configuration
-- and the service's to enforce; the database does not carry that policy.
ALTER TABLE "return_disposition" ADD CONSTRAINT "ck_return_disposition_value"
  CHECK ("disposition" IN ('RESTOCK', 'REPAIR', 'REPLACE', 'RETURN_TO_SUPPLIER', 'SCRAP', 'RECYCLE'));

ALTER TABLE "return_disposition" ADD CONSTRAINT "ck_return_disposition_quantity_positive"
  CHECK ("quantity" >= 1);

-- ---- triggers ---------------------------------------------------------------

-- A shipment: IN_TRANSIT → RECEIVED → INSPECTED → RESOLVED, once each.
CREATE OR REPLACE FUNCTION "return_shipment_guard"() RETURNS trigger AS $$
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
       OR (OLD."inspected_at" IS NOT NULL
           AND (NEW."inspected_at" IS DISTINCT FROM OLD."inspected_at"
                OR NEW."inspected_by" IS DISTINCT FROM OLD."inspected_by"
                OR NEW."inspection_note" IS DISTINCT FROM OLD."inspection_note"
                OR NEW."inspection_report_document_id" IS DISTINCT FROM OLD."inspection_report_document_id"))
       OR (OLD."resolved_at" IS NOT NULL
           AND (NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"
                OR NEW."resolved_by" IS DISTINCT FROM OLD."resolved_by"))
    THEN
      RAISE EXCEPTION 'ck_return_shipment_terms_immutable: where a return comes from, goes to and what it was never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((OLD."status" = 'IN_TRANSIT' AND NEW."status" = 'RECEIVED')
            OR (OLD."status" = 'RECEIVED' AND NEW."status" = 'INSPECTED')
            OR (OLD."status" = 'INSPECTED' AND NEW."status" = 'RESOLVED'))
       OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_return_shipment_transition: a return shipment is received, then inspected, then resolved, once each'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_shipment_not_erasable: a return shipment is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- At commit: the status has its tracking event and its place in the history; the lines are all
-- there and say the same as the status (received exactly from RECEIVED on); and the dispositions
-- say the same too — none until RESOLVED, and then, per line, exactly what was received.
CREATE OR REPLACE FUNCTION "return_shipment_history_check"() RETURNS trigger AS $$
DECLARE
  current_row RECORD;
  lines RECORD;
  events INTEGER;
  unbalanced INTEGER;
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
     OR (current_row."status" <> 'IN_TRANSIT' AND lines."received" <> lines."total") THEN
    RAISE EXCEPTION 'ck_return_shipment_lines_agree: received quantities are recorded exactly when the shipment is RECEIVED or later, for every line'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO unbalanced
    FROM "return_shipment_line" l
   WHERE l."organization_id" = NEW."organization_id" AND l."return_shipment_id" = NEW."id"
     AND COALESCE((SELECT sum(d."quantity") FROM "return_disposition" d
                    WHERE d."organization_id" = l."organization_id"
                      AND d."return_shipment_id" = l."return_shipment_id"
                      AND d."order_line_id" = l."order_line_id"), 0)
         <> CASE WHEN current_row."status" = 'RESOLVED' THEN l."received_quantity" ELSE 0 END;
  IF unbalanced <> 0 THEN
    RAISE EXCEPTION 'ck_return_shipment_dispositions_balance: a resolved return shipment sends every received unit somewhere, exactly once, and an unresolved one sends none'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A disposition: written once, with the resolution that makes it, for a line of the shipment, and
-- never changed or erased.
CREATE FUNCTION "return_disposition_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "version" INTO parent
      FROM "return_shipment"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."return_shipment_id";
    IF NOT FOUND OR parent."status" <> 'RESOLVED' OR parent."version" <> 4 THEN
      RAISE EXCEPTION 'ck_return_disposition_with_resolution: dispositions are written with the resolution that makes them'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "return_shipment_line"
       WHERE "organization_id" = NEW."organization_id" AND "return_shipment_id" = NEW."return_shipment_id"
         AND "order_line_id" = NEW."order_line_id"
    ) THEN
      RAISE EXCEPTION 'ck_return_disposition_of_line: a disposition is of a line of its own return shipment'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_disposition_immutable: a disposition is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_disposition_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "return_disposition"
  FOR EACH ROW EXECUTE FUNCTION "return_disposition_guard"();

CREATE TRIGGER "tg_return_disposition_no_truncate"
  BEFORE TRUNCATE ON "return_disposition"
  FOR EACH STATEMENT EXECUTE FUNCTION "return_disposition_guard"();
