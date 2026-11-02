-- Reverses 20261023120000_usage_request_hash.
--
-- Roll the code back first: this round's code writes the column on every
-- submission with a reference. Dropping it loses the bindings of the rows
-- recorded since; the code before this round never read them, and replays
-- every reference unbound again.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "usage_record" DROP COLUMN IF EXISTS "request_hash";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023120000_usage_request_hash';

COMMIT;
