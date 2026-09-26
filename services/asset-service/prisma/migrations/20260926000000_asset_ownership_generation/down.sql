-- Reverses 20260926000000_asset_ownership_generation.
--
-- Roll the code back first: it reads and writes these columns. Dropping them
-- loses nothing the previous code used; it judged ownership by timestamps,
-- which are untouched.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "insurance_policy" DROP COLUMN IF EXISTS "ownership_generation";
ALTER TABLE "asset" DROP COLUMN IF EXISTS "ownership_generation";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926000000_asset_ownership_generation';

COMMIT;
