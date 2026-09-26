-- Audit L3-09 and L3-10: three unique indexes that did not express what they
-- were written for.
--
-- WARNING: Prisma cannot express a partial index. The three indexes created
-- here live in this migration only, and their `@@unique` counterparts were
-- removed from schema.prisma, where a comment points here. A future
-- `prisma migrate dev` diff may propose dropping them. Delete those lines from
-- the generated migration; the database needs these objects.
--
-- All-or-nothing (PR #108 review #4). Every precondition is checked first, in
-- one block, before any index is dropped. A database that fails one stops here
-- with nothing changed and the query that lists the offending rows. The
-- statements are wrapped in an explicit transaction as well. prisma migrate
-- deploy already runs a PostgreSQL migration as one transaction (verified
-- 2026-09-25: a failing statement rolled back a CREATE TABLE before it), and
-- the explicit BEGIN/COMMIT keeps that true however the script is run.
--
-- Identifiers were canonicalised by 20260925110000, just before this, so the
-- duplicate checks below compare canonical values.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $preflight$
DECLARE
  current_locations integer;
  live_tags integer;
  live_policies integer;
BEGIN
  -- L3-09. The old index allowed at most one current row per asset, so this
  -- holds on any database that index was valid on. Checked anyway: the new
  -- index is built on it.
  SELECT count(*) INTO current_locations FROM (
    SELECT 1 FROM "asset_location" WHERE "is_current"
     GROUP BY "asset_id" HAVING count(*) > 1) AS duplicates;
  IF current_locations > 0 THEN
    RAISE EXCEPTION 'asset_location: % asset(s) have more than one current location; nothing was changed', current_locations
      USING HINT = 'List them with: SELECT asset_id, array_agg(id ORDER BY recorded_at) FROM asset_location WHERE is_current GROUP BY 1 HAVING count(*) > 1; demote all but the latest (is_current = false), then deploy again.';
  END IF;

  -- L3-10. The old indexes included the nullable deleted_at, and PostgreSQL
  -- treats every NULL as distinct, so two live rows with the same tag or
  -- policy number never collided. Such duplicates may exist; choosing which
  -- one survives is an operator's decision, not this migration's.
  SELECT count(*) INTO live_tags FROM (
    SELECT 1 FROM "asset"
     WHERE "deleted_at" IS NULL AND "asset_tag" IS NOT NULL
     GROUP BY "organization_id", "asset_tag" HAVING count(*) > 1) AS duplicates;
  IF live_tags > 0 THEN
    RAISE EXCEPTION 'asset: % live asset tag(s) are used twice in one organization; nothing was changed', live_tags
      USING HINT = 'List them with: SELECT organization_id, asset_tag, array_agg(id) FROM asset WHERE deleted_at IS NULL AND asset_tag IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1; retag or retire one of each, then deploy again.';
  END IF;

  SELECT count(*) INTO live_policies FROM (
    SELECT 1 FROM "insurance_policy"
     WHERE "deleted_at" IS NULL
     GROUP BY "policy_number", "insurer_name" HAVING count(*) > 1) AS duplicates;
  IF live_policies > 0 THEN
    RAISE EXCEPTION 'insurance_policy: % live policy number(s) are recorded twice for one insurer; nothing was changed', live_policies
      USING HINT = 'List them with: SELECT policy_number, insurer_name, array_agg(id), array_agg(asset_id) FROM insurance_policy WHERE deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1; correct or retire one of each, then deploy again.';
  END IF;
END
$preflight$;

-- L3-09: one CURRENT location per asset.
--
-- UNIQUE (asset_id, is_current) also allowed only one *historical* row per
-- asset, so recording a third location failed when the second was demoted.
-- The intent was always this partial index.
DROP INDEX IF EXISTS "asset_location_asset_id_is_current_key";
CREATE UNIQUE INDEX "ux_asset_location_current"
  ON "asset_location" ("asset_id")
  WHERE "is_current";

-- L3-10: one ACTIVE asset tag per organization, one ACTIVE policy number per
-- insurer.
DROP INDEX IF EXISTS "asset_organization_id_asset_tag_deleted_at_key";
CREATE UNIQUE INDEX "ux_asset_tag_active"
  ON "asset" ("organization_id", "asset_tag")
  WHERE "deleted_at" IS NULL;

DROP INDEX IF EXISTS "insurance_policy_policy_number_insurer_name_deleted_at_key";
CREATE UNIQUE INDEX "ux_insurance_policy_number_active"
  ON "insurance_policy" ("policy_number", "insurer_name")
  WHERE "deleted_at" IS NULL;

COMMIT;
