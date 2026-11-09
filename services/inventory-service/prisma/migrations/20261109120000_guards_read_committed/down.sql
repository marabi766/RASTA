-- Reverse of `migration.sql` (20261109120000_guards_read_committed).
--
-- Gives 20261017170000's two guards back, byte for byte (they take the lock themselves), then drops
-- the gate. Nothing was rewritten going up, so nothing is put back; the service names neither, so
-- the release need not be rolled back first.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION "return_dispatch_withdrawal_guard"() RETURNS trigger AS $$
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

CREATE OR REPLACE FUNCTION "return_shipment_dispatch_fence"() RETURNS trigger AS $$
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

DROP FUNCTION read_committed_xact_lock(BIGINT);

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109120000_guards_read_committed';

COMMIT;
