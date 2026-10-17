-- =============================================================================
-- Reverse of `migration.sql` (RUN-005 PR 2b).
--
-- Drops the disposition table and its guard, puts the return shipment's guard and its commit-time
-- check back as PR 2a wrote them, narrows the CHECK constraints to IN_TRANSIT → RECEIVED and drops
-- the inspection and resolution columns. Nothing of PR 2a's tables, rows or triggers is dropped.
--
-- **This destroys every disposition, every inspection note and report reference, and the
-- INSPECTED/RESOLVED history.** Run it only when no return shipment has been inspected: the CHECK
-- constraints below refuse a row still INSPECTED or RESOLVED (the reversal fails loudly and
-- changes nothing), and a database that has such rows needs a restore from backup, not this file.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_return_disposition_no_truncate" ON "return_disposition";
DROP TRIGGER IF EXISTS "tg_return_disposition_guard" ON "return_disposition";
DROP FUNCTION IF EXISTS "return_disposition_guard"();
DROP TABLE IF EXISTS "return_disposition";

-- The tracking events of the states PR 2a does not know would violate the narrower type check.
ALTER TABLE "return_tracking_event" DROP CONSTRAINT "ck_return_tracking_event_type";
ALTER TABLE "return_tracking_event" ADD CONSTRAINT "ck_return_tracking_event_type"
  CHECK ("type" IN ('IN_TRANSIT', 'RECEIVED'));

ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_inspection";

ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_timestamps_ordered";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_timestamps_ordered"
  CHECK ("updated_at" >= "created_at"
         AND ("received_at" IS NULL OR "received_at" >= "created_at"));

ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_actor_recorded";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("created_correlation_id") <> ''
         AND ("received_by" IS NULL OR btrim("received_by") <> ''));

ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_version_matches_status";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_version_matches_status"
  CHECK ("version" = CASE "status" WHEN 'IN_TRANSIT' THEN 1 ELSE 2 END);

ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_status_coherent";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_status_coherent"
  CHECK (
    (("status" = 'IN_TRANSIT' AND "received_at" IS NULL)
  OR ("status" = 'RECEIVED'   AND "received_at" IS NOT NULL))
    AND ("received_at" IS NULL) = ("received_by" IS NULL)
  );

ALTER TABLE "return_shipment" DROP CONSTRAINT "ck_return_shipment_status";
ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_status"
  CHECK ("status" IN ('IN_TRANSIT', 'RECEIVED'));

ALTER TABLE "return_shipment"
  DROP COLUMN "resolved_by",
  DROP COLUMN "resolved_at",
  DROP COLUMN "inspection_report_document_id",
  DROP COLUMN "inspection_note",
  DROP COLUMN "inspected_by",
  DROP COLUMN "inspected_at";

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

CREATE OR REPLACE FUNCTION "return_shipment_history_check"() RETURNS trigger AS $$
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

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016130000_return_inspection_resolution';
