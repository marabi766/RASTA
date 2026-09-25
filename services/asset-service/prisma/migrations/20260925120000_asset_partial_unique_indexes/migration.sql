-- Audit L3-09 and L3-10: three unique indexes that did not express what they
-- were written for.
--
-- WARNING: Prisma cannot express a partial index. The three indexes created
-- here live in this migration only, and their `@@unique` counterparts were
-- removed from schema.prisma, where a comment points here. A future
-- `prisma migrate dev` diff may propose dropping them. Delete those lines from
-- the generated migration; the database needs these objects.

SET LOCAL lock_timeout = '3s';

-- L3-09: one CURRENT location per asset.
--
-- UNIQUE (asset_id, is_current) also allowed only one *historical* row per
-- asset, so recording a third location failed when the second was demoted.
-- The intent was always this partial index.
--
-- Existing rows: the old index allowed at most one current row per asset, so
-- this index builds on any database the old one was valid on.
DROP INDEX IF EXISTS "asset_location_asset_id_is_current_key";
CREATE UNIQUE INDEX "ux_asset_location_current"
  ON "asset_location" ("asset_id")
  WHERE "is_current";

-- L3-10: one ACTIVE asset tag per organization, one ACTIVE policy number per
-- insurer.
--
-- The old indexes included the nullable `deleted_at`. PostgreSQL treats every
-- NULL as distinct, so two live rows with the same tag (both deleted_at NULL)
-- never collided, and the application pre-check lost to a concurrent insert.
--
-- Existing rows: if live duplicates already exist, CREATE UNIQUE INDEX fails
-- and this migration stops. Nothing is changed silently, because choosing
-- which duplicate survives is an operator's decision. Find them first with:
--
--   SELECT organization_id, asset_tag, count(*) FROM asset
--   WHERE deleted_at IS NULL AND asset_tag IS NOT NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
--   SELECT policy_number, insurer_name, count(*) FROM insurance_policy
--   WHERE deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Values stored before this release are not canonicalised (Arabic yeh or kaf,
-- non-Latin digits). New input is canonicalised at the API boundary
-- (src/asset/identifier.ts). An old value written with a variant spelling
-- therefore still does not collide with its canonical twin.
DROP INDEX IF EXISTS "asset_organization_id_asset_tag_deleted_at_key";
CREATE UNIQUE INDEX "ux_asset_tag_active"
  ON "asset" ("organization_id", "asset_tag")
  WHERE "deleted_at" IS NULL;

DROP INDEX IF EXISTS "insurance_policy_policy_number_insurer_name_deleted_at_key";
CREATE UNIQUE INDEX "ux_insurance_policy_number_active"
  ON "insurance_policy" ("policy_number", "insurer_name")
  WHERE "deleted_at" IS NULL;
