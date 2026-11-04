-- =============================================================================
-- Reverse of `migration.sql` (COM-007 PR 8).
--
-- Refuses, and changes nothing, while any quotation or receipt exists: each is a supplier's sealed
-- offer and the chain audit-service holds a copy of — dropping them would leave that copy pointing
-- at nothing. With none, it drops the guards and the two tables.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "quotation") OR EXISTS (SELECT 1 FROM "quotation_receipt") THEN
    RAISE EXCEPTION 'refusing to reverse 20261103100000_quotation: quotation holds sealed quotations or their receipts, refusing to drop them';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS "tg_quotation_receipt_check" ON "quotation";
DROP TRIGGER IF EXISTS "tg_quotation_receipt_no_truncate" ON "quotation_receipt";
DROP TRIGGER IF EXISTS "tg_quotation_receipt_guard" ON "quotation_receipt";
DROP TRIGGER IF EXISTS "tg_quotation_no_truncate" ON "quotation";
DROP TRIGGER IF EXISTS "tg_quotation_guard" ON "quotation";

DROP TABLE IF EXISTS "quotation_receipt";
DROP TABLE IF EXISTS "quotation";

DROP FUNCTION IF EXISTS "quotation_receipt_check"();
DROP FUNCTION IF EXISTS "quotation_receipt_guard"();
DROP FUNCTION IF EXISTS "quotation_guard"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103100000_quotation';
