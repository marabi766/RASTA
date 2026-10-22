-- =============================================================================
-- inventory-service — the dispatch withdrawal: the fence that lets marketplace release a dispatch
-- reservation without ever releasing goods that left (RUN-005; Codex r1 on #339, finding 2; PM
-- ruling on docs/24 Q-133 (9)(a); docs/23 D-058).
--
-- Before a return shipment is recorded here, marketplace reserves its dispatch on the return
-- request (`dispatch_reservation_id`, `RDR_<ULID>`), which ends the buyer's right to cancel. If
-- the dispatch then fails — this service's transaction rolls back, or its process dies — no
-- shipment exists and the reservation would stand for good. No clock may release it: the goods
-- may have left. Marketplace instead asks HERE, and this is the one place that can answer:
--
--   * a shipment exists for the request → the goods may be on the road: the reservation stands;
--   * none does → the reservation id is recorded as WITHDRAWN, and from then on no shipment
--     carrying it is ever written — however late a delayed dispatch commits.
--
-- Both decisions take one transaction-scoped advisory lock per (organization, return request) —
-- `hashtextextended('return-dispatch|' || organization_id || '|' || return_request_id, 0)`, the
-- key the service takes first, so its own checks run under it too — so a shipment and a
-- withdrawal for one request are serialised: whichever commits first, the other sees it and is
-- refused. The triggers below take it again and decide again, whatever a future write path
-- forgets.
--
-- A shipment recorded before this migration has no reservation id (marketplace had none to give):
-- it keeps NULL, and still counts as "a shipment exists". Every shipment written from now on
-- carries the reservation it was dispatched under.
--
-- Nothing here moves stock or money.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

ALTER TABLE "return_shipment" ADD COLUMN "dispatch_reservation_id" TEXT;

ALTER TABLE "return_shipment" ADD CONSTRAINT "ck_return_shipment_dispatch_reservation"
  CHECK ("dispatch_reservation_id" IS NULL
         OR "dispatch_reservation_id" ~ '^RDR_[0-9A-HJKMNP-TV-Z]{26}$');

-- CreateTable
CREATE TABLE "return_dispatch_withdrawal" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_request_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "withdrawn_at" TIMESTAMPTZ(3) NOT NULL,
    "withdrawn_by" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "return_dispatch_withdrawal_pkey" PRIMARY KEY ("id")
);

-- A reservation is withdrawn once, in the books of the organization that would have dispatched it.
CREATE UNIQUE INDEX "ux_return_dispatch_withdrawal_reservation" ON "return_dispatch_withdrawal"("organization_id", "reservation_id");
CREATE INDEX "ix_return_dispatch_withdrawal_request" ON "return_dispatch_withdrawal"("organization_id", "return_request_id");

ALTER TABLE "return_dispatch_withdrawal" ADD CONSTRAINT "ck_return_dispatch_withdrawal_ids"
  CHECK ("id" ~ '^RDW_[0-9A-HJKMNP-TV-Z]{26}$'
         AND "return_request_id" ~ '^RET_[0-9A-HJKMNP-TV-Z]{26}$'
         AND "reservation_id" ~ '^RDR_[0-9A-HJKMNP-TV-Z]{26}$');

ALTER TABLE "return_dispatch_withdrawal" ADD CONSTRAINT "ck_return_dispatch_withdrawal_actor_recorded"
  CHECK (btrim("withdrawn_by") <> '' AND btrim("correlation_id") <> '');

-- =============================================================================
-- Triggers. The runtime role owns nothing and can disable none of them (D-045).
-- =============================================================================

-- ---- a withdrawal: only while the request has no shipment here; never changed or erased ----

CREATE FUNCTION "return_dispatch_withdrawal_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('return-dispatch|' || NEW."organization_id" || '|' || NEW."return_request_id", 0));
    IF EXISTS (SELECT 1 FROM "return_shipment"
                WHERE "organization_id" = NEW."organization_id"
                  AND "return_request_id" = NEW."return_request_id") THEN
      RAISE EXCEPTION 'ck_return_dispatch_withdrawal_without_shipment: a dispatch is withdrawn only while its return has no shipment'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_return_dispatch_withdrawal_append_only: a withdrawal is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_dispatch_withdrawal_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "return_dispatch_withdrawal"
  FOR EACH ROW EXECUTE FUNCTION "return_dispatch_withdrawal_guard"();

CREATE TRIGGER "tg_return_dispatch_withdrawal_no_truncate"
  BEFORE TRUNCATE ON "return_dispatch_withdrawal"
  FOR EACH STATEMENT EXECUTE FUNCTION "return_dispatch_withdrawal_guard"();

-- ---- a new shipment: under a reservation that was not withdrawn; the reservation never changes ----
--
-- Its own trigger beside `tg_return_shipment_guard`, which stays as the earlier migrations wrote it.

CREATE FUNCTION "return_shipment_dispatch_fence"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dispatch_reservation_id" IS NULL THEN
      RAISE EXCEPTION 'ck_return_shipment_reserved: a return shipment is recorded under the dispatch reservation marketplace gave it'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('return-dispatch|' || NEW."organization_id" || '|' || NEW."return_request_id", 0));
    IF EXISTS (SELECT 1 FROM "return_dispatch_withdrawal"
                WHERE "organization_id" = NEW."organization_id"
                  AND "reservation_id" = NEW."dispatch_reservation_id") THEN
      RAISE EXCEPTION 'ck_return_shipment_reservation_withdrawn: a withdrawn dispatch reservation records no shipment'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."dispatch_reservation_id" IS DISTINCT FROM OLD."dispatch_reservation_id" THEN
    RAISE EXCEPTION 'ck_return_shipment_reservation_immutable: the reservation a shipment was dispatched under never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_return_shipment_dispatch_fence"
  BEFORE INSERT OR UPDATE ON "return_shipment"
  FOR EACH ROW EXECUTE FUNCTION "return_shipment_dispatch_fence"();
