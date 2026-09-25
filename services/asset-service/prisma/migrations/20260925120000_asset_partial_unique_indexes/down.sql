-- Reverses 20260925120000_asset_partial_unique_indexes.
--
-- Roll the code back first. The code relies on the partial indexes to refuse
-- a concurrent duplicate.
--
-- Refuses before touching any index when an old constraint cannot be restored
-- (PR #108 review #4), instead of failing half-way:
--
--   - UNIQUE (asset_id, is_current) allows one *historical* row per asset.
--     After this migration an asset may have many, and recreating it would
--     fail. Making it succeed would mean deleting location history, which a
--     rollback must not do. The check names the assets; thinning their
--     history out is a decision for a person.
--   - The old composite indexes include deleted_at. Two soft-deleted rows
--     with the same tag or policy number and the same deletion instant
--     would collide under them (live rows never do: NULLs are distinct).
--
-- Atomic, like the migration.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $preflight$
DECLARE
  historical_locations integer;
  deleted_tags integer;
  deleted_policies integer;
BEGIN
  SELECT count(*) INTO historical_locations FROM (
    SELECT 1 FROM "asset_location"
     GROUP BY "asset_id", "is_current" HAVING count(*) > 1) AS duplicates;
  IF historical_locations > 0 THEN
    RAISE EXCEPTION 'asset_location: % asset(s) have more than one location in the same state; UNIQUE (asset_id, is_current) cannot be restored, nothing was changed', historical_locations
      USING HINT = 'List them with: SELECT asset_id, is_current, count(*) FROM asset_location GROUP BY 1, 2 HAVING count(*) > 1; the old index allowed one historical location per asset, so rolling back loses history. Keep this migration unless that loss is decided.';
  END IF;

  SELECT count(*) INTO deleted_tags FROM (
    SELECT 1 FROM "asset"
     WHERE "deleted_at" IS NOT NULL AND "asset_tag" IS NOT NULL
     GROUP BY "organization_id", "asset_tag", "deleted_at" HAVING count(*) > 1) AS duplicates;
  IF deleted_tags > 0 THEN
    RAISE EXCEPTION 'asset: % retired asset tag(s) share a deletion instant; the old composite index cannot be restored, nothing was changed', deleted_tags
      USING HINT = 'List them with: SELECT organization_id, asset_tag, deleted_at, array_agg(id) FROM asset WHERE deleted_at IS NOT NULL AND asset_tag IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;';
  END IF;

  SELECT count(*) INTO deleted_policies FROM (
    SELECT 1 FROM "insurance_policy"
     WHERE "deleted_at" IS NOT NULL
     GROUP BY "policy_number", "insurer_name", "deleted_at" HAVING count(*) > 1) AS duplicates;
  IF deleted_policies > 0 THEN
    RAISE EXCEPTION 'insurance_policy: % retired policy number(s) share a deletion instant; the old composite index cannot be restored, nothing was changed', deleted_policies
      USING HINT = 'List them with: SELECT policy_number, insurer_name, deleted_at, array_agg(id) FROM insurance_policy WHERE deleted_at IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;';
  END IF;
END
$preflight$;

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

COMMIT;
