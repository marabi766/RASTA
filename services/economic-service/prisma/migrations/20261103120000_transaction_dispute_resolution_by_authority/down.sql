-- Reverse of `migration.sql` (20261103120000_transaction_dispute_resolution_by_authority).
--
-- Drops the trigger that holds a resolution to the transaction's settlement
-- authority, and gives `assign_transaction_resolved_dispute` back its
-- 20261022120000 body. Run with the previous release deployed: it resolves
-- every dispute to PENDING_SETTLEMENT and neither knows nor needs either.
-- Rows already resolved to HELD stay HELD with their `resolved_dispute_id`:
-- HELD is a state that release reads and moves correctly (it authorises,
-- refunds or disputes from it). Catalogue changes only, bounded as
-- `migration.sql` is.
BEGIN;

SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

DROP TRIGGER IF EXISTS "trg_transaction_dispute_resolution" ON "transaction";
DROP FUNCTION IF EXISTS enforce_transaction_dispute_resolution();

CREATE OR REPLACE FUNCTION assign_transaction_resolved_dispute() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."resolved_dispute_id" := NULL;
  ELSIF OLD."status" = 'DISPUTED' AND NEW."status" = 'PENDING_SETTLEMENT' THEN
    NEW."resolved_dispute_id" := OLD."dispute_id";
  ELSIF OLD."resolved_dispute_id" IS NULL
        AND OLD."status" IN ('PENDING_SETTLEMENT', 'SETTLED')
        AND OLD."disputed_at" IS NOT NULL
        AND OLD."dispute_resolved_at" IS NOT NULL THEN
    -- Resolved before this column existed: its latest dispute's.
    NEW."resolved_dispute_id" := OLD."dispute_id";
  ELSE
    NEW."resolved_dispute_id" := OLD."resolved_dispute_id";
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103120000_transaction_dispute_resolution_by_authority';

COMMIT;
