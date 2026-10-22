-- Reverse of `migration.sql` (20261022120000_transaction_resolved_dispute).
--
-- Drops the resolved dispute's identity and the trigger that assigns it. Run
-- with the previous release deployed: it neither writes nor reads the column.
-- Nothing is refused: no decision rests on it — the resolution's text, who
-- and when stay on the row, and resolving names `dispute_id`, which this
-- leaves alone. What is lost is the attribution of a refunded row's
-- resolution, which readers then judge by time again, as for any row resolved
-- before this migration; a re-apply backfills the rows it can be sure of
-- (docs/23 D-060).
BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS "trg_transaction_resolved_dispute" ON "transaction";
DROP FUNCTION IF EXISTS assign_transaction_resolved_dispute();

ALTER TABLE "transaction" DROP COLUMN IF EXISTS "resolved_dispute_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022120000_transaction_resolved_dispute';

COMMIT;
