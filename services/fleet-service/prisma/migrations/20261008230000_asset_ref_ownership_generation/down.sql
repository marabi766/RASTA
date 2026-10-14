-- Reverses 20261008230000_asset_ref_ownership_generation (#240 round 2).
--
-- Run `insurance:clear-transferred` BEFORE this, with the code that has it: it
-- reads both columns (#240 r13). Then roll the code back, then this file
-- (runbook insurance-reprojection.md, "rollback", fixed order). Dropping the
-- columns forgets the generation and the retained coverages; the windows already
-- filtered at a transfer stay filtered.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "retained_coverages";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "ownership_generation";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261008230000_asset_ref_ownership_generation';

COMMIT;
