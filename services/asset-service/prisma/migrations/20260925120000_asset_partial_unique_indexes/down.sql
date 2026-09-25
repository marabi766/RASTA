-- Reverses 20260925120000_asset_partial_unique_indexes.
--
-- Roll the code back first. The code relies on the partial indexes to refuse
-- a concurrent duplicate.
--
-- The location index is the one that can refuse to come back. The old
-- UNIQUE (asset_id, is_current) allows one historical row per asset, and
-- after this migration an asset may have many. Recreating it then fails, and
-- the rollback stops with nothing changed. That is deliberate: making it
-- succeed would mean deleting location history. Thin the history out by hand
-- first if the rollback is really wanted.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ux_insurance_policy_number_active";
CREATE UNIQUE INDEX "insurance_policy_policy_number_insurer_name_deleted_at_key"
  ON "insurance_policy" ("policy_number", "insurer_name", "deleted_at");

DROP INDEX IF EXISTS "ux_asset_tag_active";
CREATE UNIQUE INDEX "asset_organization_id_asset_tag_deleted_at_key"
  ON "asset" ("organization_id", "asset_tag", "deleted_at");

DROP INDEX IF EXISTS "ux_asset_location_current";
CREATE UNIQUE INDEX "asset_location_asset_id_is_current_key"
  ON "asset_location" ("asset_id", "is_current");

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120000_asset_partial_unique_indexes';
