-- Reverse of `migration.sql` (20261022120000_transaction_resolved_dispute).
--
-- Drops the resolved dispute's identity and the trigger that assigns it. Run
-- with the previous release deployed: it neither writes nor reads the column.
-- Nothing is refused: no decision rests on it — the resolution's text, who
-- and when stay on the row, and resolving names `dispute_id`, which this
-- leaves alone. What is lost is the attribution of a refunded row's
-- resolution, which readers then judge by time again, as for any row resolved
-- before this migration; after a re-apply the trigger and the backfill
-- attribute again the rows they can be sure of (docs/23 D-060). Catalogue
-- changes only, bounded as `migration.sql` is: run it with
-- `PGOPTIONS='-c rasta.migration_statement_timeout=<t>'` to raise the 5 s.
BEGIN;

SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

DROP TRIGGER IF EXISTS "trg_transaction_resolved_dispute" ON "transaction";
DROP FUNCTION IF EXISTS assign_transaction_resolved_dispute();

ALTER TABLE "transaction" DROP COLUMN IF EXISTS "resolved_dispute_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022120000_transaction_resolved_dispute';

COMMIT;
