-- Reverses 20261103130000_order_dispute_origin.
--
-- Roll the code back first: the previous release neither reads nor writes the column, and it
-- resolves SETTLE to RECEIPT_CONFIRMED again (marketplace audit F1) — rolling back reopens that
-- defect for every dispute still open. Nothing is refused: no row depends on the column or on
-- the constraint for its meaning. The recorded origins are dropped with the column; a re-apply
-- records again only the open disputes whose history is certain, as the first apply did.

SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "ck_order_receipt_confirmed_has_evidence";

DROP TRIGGER IF EXISTS "trg_order_dispute_origin" ON "order_dispute";
DROP FUNCTION IF EXISTS assign_order_dispute_origin();

ALTER TABLE "order_dispute" DROP CONSTRAINT IF EXISTS "ck_order_dispute_raised_from";
ALTER TABLE "order_dispute" DROP COLUMN IF EXISTS "raised_from_status";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103130000_order_dispute_origin';
