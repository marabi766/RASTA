-- The return-dispatch fence locks and then reads only under READ COMMITTED (FU-268, #983 r1 F3).
--
-- `return_dispatch_withdrawal_guard` and `return_shipment_dispatch_fence` (20261017170000) take the
-- request's lock, then ask whether the other side was written. Under REPEATABLE READ or SERIALIZABLE
-- that read uses the transaction's first snapshot, from before the wait: a withdrawal and a shipment
-- under the same reservation could both be recorded. As in economic-service's migration of the same
-- name, the lock is now taken through `read_committed_xact_lock`, which refuses a NULL key (no lock)
-- and, once it holds the lock, every level but READ COMMITTED, with `restrict_violation`. The key is
-- unchanged, so `ReturnShipmentRepository` (which takes it too) still waits on the same lock. The
-- migration verifier refuses any function that names an advisory lock itself.
--
-- search_path: the gate reads no relation and names every built-in by `pg_catalog`. Pinning the
-- guards' path (the FU-266 rule) is refused by `check:utc-clock-sites`; it waits for FU-266.
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION read_committed_xact_lock(lock_key BIGINT)
RETURNS VOID AS $$
BEGIN
  IF lock_key IS NULL THEN
    RAISE EXCEPTION 'An advisory lock with no key locks nothing'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(lock_key);
  -- After the lock, as before: a refused level still waits its turn, then reads nothing.
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'A guard that locks and then reads runs only under READ COMMITTED'
      USING ERRCODE = 'restrict_violation';
  END IF;
END; $$ LANGUAGE plpgsql VOLATILE;

-- The runtime role calls it through the guards below, which run as the writer
-- (runtime-function-grants.txt names it too).
GRANT EXECUTE ON FUNCTION read_committed_xact_lock(BIGINT) TO rasta_inventory;

CREATE OR REPLACE FUNCTION "return_dispatch_withdrawal_guard"() RETURNS trigger AS $$
DECLARE lock_key BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    lock_key := hashtextextended('return-dispatch|' || NEW."organization_id" || '|' || NEW."return_request_id", 0);
    PERFORM read_committed_xact_lock(lock_key);
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
DECLARE lock_key BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dispatch_reservation_id" IS NULL THEN
      RAISE EXCEPTION 'ck_return_shipment_reserved: a return shipment is recorded under the dispatch reservation marketplace gave it'
        USING ERRCODE = 'check_violation';
    END IF;
    lock_key := hashtextextended('return-dispatch|' || NEW."organization_id" || '|' || NEW."return_request_id", 0);
    PERFORM read_committed_xact_lock(lock_key);
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
