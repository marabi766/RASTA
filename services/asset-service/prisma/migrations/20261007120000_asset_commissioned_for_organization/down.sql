-- Reverses 20261007120000_asset_commissioned_for_organization: drops the column. Nothing else
-- changes; the previous rule (the dossier decides) applies again, which refuses return to service
-- for an asset that has no document references — the behaviour this migration fixed.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset" DROP COLUMN IF EXISTS "commissioned_for_organization_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261007120000_asset_commissioned_for_organization';

COMMIT;
