-- =============================================================================
-- marketplace-service — the physical half of a return, as the request states it (RUN-005 PR 3,
-- ADR-048 § 2, § 3; docs/23 D-058).
--
-- inventory-service owns the return shipment, its receipt, inspection and disposition, and says
-- so on `rasta.inventory.v1` (`RETURN_SHIPMENT_*`). marketplace mirrors each step onto its own
-- request once it has checked the event against that request (`return-mirror.consumer.ts`):
--
--     AUTHORIZED → IN_TRANSIT → RECEIVED → INSPECTED → RESOLVED      (versions 3, 4, 5, 6)
--
-- 20261016100000_return_request kept the status a CHECK, not an enum, for exactly this widening.
-- What is added is what the request needs to say which shipment it is and when each step
-- happened: the shipment id, one instant per step, and the inspection report's document id. What
-- arrived per line and what became of it stay inventory's facts; they are on the mirrored events,
-- not stored twice. Nothing here moves money, stock or a file, and no status is a refund.
--
-- The trigger still keeps the whole lifecycle: no command and no consumer can skip a step, leave
-- a physical state but forward, cancel goods already on the road (Q-133 (5)), or change which
-- shipment a request is or when a step happened once recorded.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

ALTER TABLE "return_request"
  ADD COLUMN "return_shipment_id" TEXT,
  ADD COLUMN "in_transit_at" TIMESTAMPTZ(3),
  ADD COLUMN "received_at" TIMESTAMPTZ(3),
  ADD COLUMN "inspected_at" TIMESTAMPTZ(3),
  ADD COLUMN "inspection_report_document_id" TEXT,
  ADD COLUMN "resolved_at" TIMESTAMPTZ(3);

-- One shipment is one request's: inventory keeps one shipment per return (Q-133 (4)), and a
-- shipment mirrored onto a request is never mirrored onto another of the same buyer.
CREATE UNIQUE INDEX "ux_return_request_shipment" ON "return_request"("organization_id", "return_shipment_id");

ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_shipment_id"
  CHECK ("return_shipment_id" IS NULL OR "return_shipment_id" ~ '^RSP_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_report_document_id"
  CHECK ("inspection_report_document_id" IS NULL
         OR "inspection_report_document_id" ~ '^DOC_[0-9A-HJKMNP-TV-Z]{26}$');

-- ---- the eight states ----------------------------------------------------------

ALTER TABLE "return_request" DROP CONSTRAINT "ck_return_request_status";
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_status"
  CHECK ("status" IN ('REQUESTED', 'AUTHORIZED', 'REJECTED', 'CANCELLED',
                      'IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED'));

-- Each status says when it was reached and by whom, and no other decision is on the row. A
-- physical status was authorized first, names its shipment, and carries the instant of every step
-- up to its own and of none after it. The report is an inspection's, so it comes with one.
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
          OR ("cancelled_from" = 'AUTHORIZED' AND "authorized_at" IS NOT NULL)))
  OR ("status" IN ('IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED')
        AND "authorized_at" IS NOT NULL AND "rejected_at" IS NULL AND "cancelled_at" IS NULL
        AND "cancelled_from" IS NULL))
    AND ("authorized_at" IS NULL) = ("authorized_by" IS NULL)
    AND ("rejected_at"   IS NULL) = ("rejected_by"   IS NULL)
    AND ("cancelled_at"  IS NULL) = ("cancelled_by"  IS NULL)
    AND ("return_shipment_id" IS NOT NULL) = ("status" IN ('IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED'))
    AND ("in_transit_at" IS NOT NULL) = ("status" IN ('IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED'))
    AND ("received_at" IS NOT NULL) = ("status" IN ('RECEIVED', 'INSPECTED', 'RESOLVED'))
    AND ("inspected_at" IS NOT NULL) = ("status" IN ('INSPECTED', 'RESOLVED'))
    AND ("resolved_at" IS NOT NULL) = ("status" = 'RESOLVED')
    AND ("inspection_report_document_id" IS NULL OR "inspected_at" IS NOT NULL)
  );

-- `version` is the request's position in its own history: one per status reached.
ALTER TABLE "return_request" DROP CONSTRAINT "ck_return_request_version_matches_status";
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_version_matches_status"
  CHECK ("version" = CASE "status"
                       WHEN 'REQUESTED' THEN 1
                       WHEN 'AUTHORIZED' THEN 2
                       WHEN 'REJECTED' THEN 2
                       WHEN 'IN_TRANSIT' THEN 3
                       WHEN 'RECEIVED' THEN 4
                       WHEN 'INSPECTED' THEN 5
                       WHEN 'RESOLVED' THEN 6
                       ELSE CASE "cancelled_from" WHEN 'REQUESTED' THEN 2 ELSE 3 END
                     END);

ALTER TABLE "return_status_history" DROP CONSTRAINT "ck_return_history_status";
ALTER TABLE "return_status_history" ADD CONSTRAINT "ck_return_history_status"
  CHECK ("to_status" IN ('REQUESTED', 'AUTHORIZED', 'REJECTED', 'CANCELLED',
                         'IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED')
         AND ("from_status" IS NULL
              OR "from_status" IN ('REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED'))
         AND (("from_status" IS NULL) = ("version" = 1))
         AND ("to_status" = 'REQUESTED') = ("version" = 1));

-- =============================================================================
-- Triggers
-- =============================================================================

-- ---- a request: born REQUESTED, decided or withdrawn once, then the goods' steps in order ----

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

-- ---- a line: within what the order sold, counting every request not refused or withdrawn ----
--
-- Goods on the road, received, inspected or resolved were returned: their units are not
-- returnable a second time, so they count against the order line like an open request does.

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
     WHERE l."order_line_id" = NEW."order_line_id" AND r."status" NOT IN ('REJECTED', 'CANCELLED');
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
