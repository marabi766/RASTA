-- =============================================================================
-- Reverse of `migration.sql` (receipts held until their predecessor arrives).
--
-- **Refused while any receipt is held.** A held receipt was announced and has not
-- been placed in the chain yet; dropping the table would lose it, and the topic may
-- no longer carry it. Locks the table first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender_receipt_pending" IN ACCESS EXCLUSIVE MODE;

DO $preflight_pending$
DECLARE
  held bigint;
BEGIN
  SELECT count(*) INTO held FROM "tender_receipt_pending";
  IF held > 0 THEN
    RAISE EXCEPTION 'down refused: % receipt(s) are held waiting for their predecessor. Let them drain (or resolve the gap), then roll back.', held
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_pending$;

DROP TABLE IF EXISTS "tender_receipt_pending";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261001130000_tender_receipt_pending';

COMMIT;
