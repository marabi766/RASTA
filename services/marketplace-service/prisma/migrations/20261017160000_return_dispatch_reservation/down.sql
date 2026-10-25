-- Reverses 20261017160000_return_dispatch_reservation.
--
-- Roll the code back BEFORE this runs: the previous code neither reads nor writes these columns.
-- It REFUSES to run while an AUTHORIZED request has a reservation: dropping it would let the buyer
-- cancel a return whose goods inventory may already have sent (Q-133 (5)) — the defect this
-- migration closed. It also REFUSES while any reconciliation released a reservation: those rows are
-- the only record of who released which reservation and on what answer from inventory, and are
-- not dropped. Such an environment is not rolled back; it is rolled forward. A reservation on a
-- request that has since moved on (IN_TRANSIT and after) protects nothing the lifecycle does not
-- already, and is dropped with its columns.
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "return_request"
     WHERE "status" = 'AUTHORIZED' AND "dispatch_reserved_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'down refused: an AUTHORIZED return request has a dispatch reservation; roll forward instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "return_dispatch_release") THEN
    RAISE EXCEPTION 'down refused: a dispatch reservation was released by reconciliation, and its record is kept; roll forward instead'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- ---- the function, as 20261016140000_return_request_physical wrote it -------------

CREATE OR REPLACE FUNCTION "return_request_guard"() RETURNS trigger AS $$
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
       -- Which shipment a request is, and when each step happened, never change once recorded.
       OR (OLD."return_shipment_id" IS NOT NULL
           AND NEW."return_shipment_id" IS DISTINCT FROM OLD."return_shipment_id")
       OR (OLD."in_transit_at" IS NOT NULL AND NEW."in_transit_at" IS DISTINCT FROM OLD."in_transit_at")
       OR (OLD."received_at" IS NOT NULL AND NEW."received_at" IS DISTINCT FROM OLD."received_at")
       OR (OLD."inspected_at" IS NOT NULL
           AND (NEW."inspected_at" IS DISTINCT FROM OLD."inspected_at"
                OR NEW."inspection_report_document_id" IS DISTINCT FROM OLD."inspection_report_document_id"))
       OR (OLD."resolved_at" IS NOT NULL AND NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at")
    THEN
      RAISE EXCEPTION 'ck_return_request_terms_immutable: what was asked, of which order and by whom never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((OLD."status" = 'REQUESTED' AND NEW."status" IN ('AUTHORIZED', 'REJECTED', 'CANCELLED'))
            OR (OLD."status" = 'AUTHORIZED' AND NEW."status" IN ('CANCELLED', 'IN_TRANSIT'))
            OR (OLD."status" = 'IN_TRANSIT' AND NEW."status" = 'RECEIVED')
            OR (OLD."status" = 'RECEIVED' AND NEW."status" = 'INSPECTED')
            OR (OLD."status" = 'INSPECTED' AND NEW."status" = 'RESOLVED'))
       OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_return_request_transition: a request is authorized, rejected or cancelled from REQUESTED, cancelled or sent from AUTHORIZED, and then received, inspected and resolved in that order'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_request_not_erasable: a return request is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "tg_return_dispatch_release_no_truncate" ON "return_dispatch_release";
DROP TRIGGER IF EXISTS "tg_return_dispatch_release_guard" ON "return_dispatch_release";
DROP FUNCTION IF EXISTS "return_dispatch_release_guard"();
DROP TABLE IF EXISTS "return_dispatch_release";

ALTER TABLE "return_request" DROP CONSTRAINT IF EXISTS "ck_return_request_dispatch_reservation";

ALTER TABLE "return_request"
  DROP COLUMN IF EXISTS "dispatch_reservation_id",
  DROP COLUMN IF EXISTS "dispatch_reserved_at",
  DROP COLUMN IF EXISTS "dispatch_reserved_by",
  DROP COLUMN IF EXISTS "dispatch_reserved_correlation_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017160000_return_dispatch_reservation';
