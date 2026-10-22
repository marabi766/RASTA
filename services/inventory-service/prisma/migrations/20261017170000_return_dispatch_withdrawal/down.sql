-- =============================================================================
-- Reverse of `migration.sql` (RUN-005, Q-133 (9)(a)).
--
-- Roll the code back BEFORE this runs: the previous code neither reads nor writes these objects.
-- It REFUSES to run while any reservation is recorded as withdrawn: dropping the record would let a
-- delayed dispatch carrying that reservation write a shipment for a return marketplace may already
-- have released — and the buyer cancelled — which is the defect this migration closed. Such an
-- environment is not rolled back; it is rolled forward. The reservation id on each shipment is
-- dropped with its column.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "return_dispatch_withdrawal") THEN
    RAISE EXCEPTION 'down refused: a dispatch reservation is recorded as withdrawn; roll forward instead'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS "tg_return_shipment_dispatch_fence" ON "return_shipment";
DROP FUNCTION IF EXISTS "return_shipment_dispatch_fence"();

DROP TRIGGER IF EXISTS "tg_return_dispatch_withdrawal_no_truncate" ON "return_dispatch_withdrawal";
DROP TRIGGER IF EXISTS "tg_return_dispatch_withdrawal_guard" ON "return_dispatch_withdrawal";
DROP FUNCTION IF EXISTS "return_dispatch_withdrawal_guard"();
DROP TABLE IF EXISTS "return_dispatch_withdrawal";

ALTER TABLE "return_shipment" DROP CONSTRAINT IF EXISTS "ck_return_shipment_dispatch_reservation";
ALTER TABLE "return_shipment" DROP COLUMN IF EXISTS "dispatch_reservation_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017170000_return_dispatch_withdrawal';
