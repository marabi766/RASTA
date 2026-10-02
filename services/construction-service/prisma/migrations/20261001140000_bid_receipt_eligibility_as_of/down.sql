-- =============================================================================
-- Reverse of `migration.sql` (the eligibility decision's effective instant).
--
-- **Refused while any receipt exists.** The column is the only record of when each
-- revision's contractor was found eligible, and the receipt table is append-only:
-- dropping it would destroy that fact. Locks the table first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "bid_receipt" IN ACCESS EXCLUSIVE MODE;

DO $preflight_eligibility$
DECLARE
  receipts bigint;
BEGIN
  SELECT count(*) INTO receipts FROM "bid_receipt";
  IF receipts > 0 THEN
    RAISE EXCEPTION 'down refused: % bid receipt(s) record when their contractor was found eligible; dropping the column would destroy that. Keep this migration.', receipts
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_eligibility$;

ALTER TABLE "bid_receipt" DROP COLUMN "eligible_as_of";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261001140000_bid_receipt_eligibility_as_of';

COMMIT;
