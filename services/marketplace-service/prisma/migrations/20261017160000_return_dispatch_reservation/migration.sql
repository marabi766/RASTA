-- =============================================================================
-- marketplace-service — the dispatch reservation: the moment an AUTHORIZED return stops being
-- cancellable (RUN-005, Codex r1 on #336 finding 2; docs/23 D-058, docs/24 Q-133 (5)).
--
-- inventory-service records that goods of a return are on their way (`POST /v1/return-shipments`),
-- and marketplace learns it from `RETURN_SHIPMENT_DISPATCHED` — later, or never while its mirror
-- consumer is off. Until then the request is still AUTHORIZED, and the buyer could cancel it: the
-- quantities a CANCELLED request held are free again, and could be asked for a second time while
-- the goods are already on the road.
--
-- So inventory asks first. Before it writes a shipment it reserves the dispatch here
-- (`POST /v1/internal/returns/{id}/dispatch-reservation`), under the request's row lock — the same
-- lock a cancellation takes, which is what makes the two exclusive: whichever commits first wins,
-- and the other is refused. The reservation is recorded on the request (when, which service, under
-- which correlation id), is written once, and never changes or goes away. A reserved request can no
-- longer be cancelled; the trigger refuses it as the service does.
--
-- Nothing here moves goods, stock or money, and no status is added: the request stays AUTHORIZED
-- until the shipment's event moves it to IN_TRANSIT (its version and history are unchanged).
-- =============================================================================
SET LOCAL lock_timeout = '3s';

ALTER TABLE "return_request"
  ADD COLUMN "dispatch_reserved_at" TIMESTAMPTZ(3),
  ADD COLUMN "dispatch_reserved_by" TEXT,
  ADD COLUMN "dispatch_reserved_correlation_id" TEXT;

-- Written together or not at all, by somebody, and only on a request that was authorized and is
-- not cancelled (a REQUESTED or REJECTED request has no `authorized_at`).
ALTER TABLE "return_request" ADD CONSTRAINT "ck_return_request_dispatch_reservation"
  CHECK (("dispatch_reserved_at" IS NULL) = ("dispatch_reserved_by" IS NULL)
         AND ("dispatch_reserved_at" IS NULL) = ("dispatch_reserved_correlation_id" IS NULL)
         AND ("dispatch_reserved_by" IS NULL OR btrim("dispatch_reserved_by") <> '')
         AND ("dispatch_reserved_at" IS NULL
              OR ("authorized_at" IS NOT NULL AND "status" <> 'CANCELLED')));

-- =============================================================================
-- Trigger
-- =============================================================================

-- ---- a request: born REQUESTED, decided or withdrawn once, then the goods' steps in order ----
--
-- As 20261016140000_return_request_physical wrote it, and: a reservation is the one write that
-- moves no status — on an AUTHORIZED request, once, at the same version; once written it never
-- changes; and a reserved request is never cancelled.

CREATE OR REPLACE FUNCTION "return_request_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'ck_return_request_born_requested: a return request is created REQUESTED, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."dispatch_reserved_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_return_request_reservation_alone: a dispatch is reserved on an AUTHORIZED request, by itself'
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
       -- Nor does a dispatch reservation: it is not withdrawn, moved or reassigned.
       OR (OLD."dispatch_reserved_at" IS NOT NULL
           AND (NEW."dispatch_reserved_at" IS DISTINCT FROM OLD."dispatch_reserved_at"
                OR NEW."dispatch_reserved_by" IS DISTINCT FROM OLD."dispatch_reserved_by"
                OR NEW."dispatch_reserved_correlation_id" IS DISTINCT FROM OLD."dispatch_reserved_correlation_id"))
    THEN
      RAISE EXCEPTION 'ck_return_request_terms_immutable: what was asked, of which order and by whom never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The one write that moves no status: reserving the dispatch of an AUTHORIZED request.
    IF NEW."status" = OLD."status" THEN
      IF OLD."status" <> 'AUTHORIZED'
         OR OLD."dispatch_reserved_at" IS NOT NULL
         OR NEW."dispatch_reserved_at" IS NULL
         OR NEW."version" <> OLD."version" THEN
        RAISE EXCEPTION 'ck_return_request_transition: without a move, only the dispatch of an AUTHORIZED request is reserved, once'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD."dispatch_reserved_at" IS NULL AND NEW."dispatch_reserved_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_return_request_reservation_alone: a dispatch is reserved on an AUTHORIZED request, by itself'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Goods of a reserved request may already be on the road (Q-133 (5)): it is not withdrawn.
    IF NEW."status" = 'CANCELLED' AND OLD."dispatch_reserved_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_return_request_cancel_after_dispatch: a return whose dispatch is reserved is not cancelled'
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
