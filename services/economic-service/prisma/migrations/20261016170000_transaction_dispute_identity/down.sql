-- Reverse of `migration.sql` (20261016170000_transaction_dispute_identity).
--
-- Drops the dispute identity and the trigger that assigns it. Run with the
-- previous release deployed: it neither sends nor reads one. Nothing is
-- refused: the identity records no fact of its own, only which dispute is
-- which. A saga that holds an identity from before the rollback and resolves
-- after a later re-apply is refused — the backfill gives every dispute a new
-- one — and stops with the funds held for an operator, which is the safe side
-- (docs/23 D-053).
BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS "trg_transaction_dispute_identity" ON "transaction";
DROP FUNCTION IF EXISTS assign_transaction_dispute_identity();

ALTER TABLE "transaction" DROP COLUMN IF EXISTS "dispute_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016170000_transaction_dispute_identity';

COMMIT;
