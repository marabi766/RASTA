-- Reverses 20261016140000_return_request_physical.
--
-- Roll the code back BEFORE this runs: the previous code neither reads nor writes these columns,
-- and its consumer does not exist. It REFUSES to run while any request is in a physical state
-- (IN_TRANSIT, RECEIVED, INSPECTED, RESOLVED): the narrower rules below would not hold for it, and
-- the only way to make them hold would be to delete or falsify a request whose goods really moved.
-- Such an environment is not rolled back; it is rolled forward.
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "return_request"
     WHERE "status" IN ('IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED')
  ) OR EXISTS (
    SELECT 1 FROM "return_status_history"
     WHERE "to_status" IN ('IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED')
  ) THEN
    RAISE EXCEPTION 'down refused: a return request has a physical status; roll forward instead'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- ---- the functions, as 20261016100000_return_request wrote them -----------------

CREATE OR REPLACE FUNCTION "return_line_guard"() RETURNS trigger AS $$
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

-- ---- the constraints, as 20261016100000_return_request wrote them ---------------

ALTER TABLE "return_status_history" DROP CONSTRAINT "ck_return_history_status";
ALTER TABLE "return_status_history" ADD CONSTRAINT "ck_return_history_status"
  CHECK ("to_status" IN ('REQUESTED', 'AUTHORIZED', 'REJECTED', 'CANCELLED')
         AND ("from_status" IS NULL OR "from_status" IN ('REQUESTED', 'AUTHORIZED'))
         AND (("from_status" IS NULL) = ("version" = 1))
         AND ("to_status" = 'REQUESTED') = ("version" = 1));

ALTER TABLE "return_request" DROP CONSTRAINT "ck_return_request_version_matches_status";
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_version_matches_status"
  CHECK ("version" = CASE "status"
                       WHEN 'REQUESTED' THEN 1
                       WHEN 'AUTHORIZED' THEN 2
                       WHEN 'REJECTED' THEN 2
                       ELSE CASE "cancelled_from" WHEN 'REQUESTED' THEN 2 ELSE 3 END
                     END);

ALTER TABLE "return_request" DROP CONSTRAINT "ck_return_request_status_coherent";
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

ALTER TABLE "return_request" DROP CONSTRAINT "ck_return_request_status";
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_status"
  CHECK ("status" IN ('REQUESTED', 'AUTHORIZED', 'REJECTED', 'CANCELLED'));

-- ---- the columns ----------------------------------------------------------------

ALTER TABLE "return_request" DROP CONSTRAINT IF EXISTS "ck_return_request_report_document_id";
ALTER TABLE "return_request" DROP CONSTRAINT IF EXISTS "ck_return_request_shipment_id";
DROP INDEX IF EXISTS "ux_return_request_shipment";

ALTER TABLE "return_request"
  DROP COLUMN IF EXISTS "resolved_at",
  DROP COLUMN IF EXISTS "inspection_report_document_id",
  DROP COLUMN IF EXISTS "inspected_at",
  DROP COLUMN IF EXISTS "received_at",
  DROP COLUMN IF EXISTS "in_transit_at",
  DROP COLUMN IF EXISTS "return_shipment_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016140000_return_request_physical';
