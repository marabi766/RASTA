-- =============================================================================
-- asset-service — record commissioning per ownership generation (#234 review round 2, ruling 2).
--
-- Whether an asset may return to service (OUT_OF_SERVICE -> ACTIVE) without a fresh dossier was
-- decided from the references alone, which refused assets the owner HAD commissioned: a seeded
-- active asset (commissioned_at, no document references) or a recipient whose references the
-- reconciliation runbook moved back could go ACTIVE -> OUT_OF_SERVICE and never return.
--
-- `commissioned_for_organization_id` is the organization the asset was commissioned for: set when
-- the asset is activated (or returned to service with a verified dossier), cleared by a transfer.
-- Return to service is allowed when it equals the CURRENT owner; first commissioning, and any
-- transition after a transfer, requires the dossier.
--
-- Backfill (conservative, nothing else rewritten), two statements:
--   1. an asset with `commissioned_at` that has never been transferred (ownership_generation = 0
--      and no transfer row) is commissioned for its current owner;
--   2. a TRANSFERRED asset (round 7) only where this service's own history proves the CURRENT owner
--      commissioned it: an `ASSET_ACTIVATED` line in `asset_timeline_entry` (written by `activate`,
--      which refuses without the owner's dossier) whose `organization_id` is the current owner and
--      whose `recorded_at` — the database's clock, not the user-suppliable `commissioned_at` /
--      `occurred_at` — is later than the latest `asset_transfer.transferred_at`. A transfer
--      re-stamps older lines with the new owner's id, so the instant after the latest transfer is
--      what proves it, not the organization alone. A status change to ACTIVE does not prove it: the
--      old code let REGISTERED -> OUT_OF_SERVICE -> ACTIVE through without a dossier.
-- Every other transferred row stays NULL: the current owner attaches a dossier before the asset
-- returns to service, and that activation sets the column.
--
-- Locked like 20260926000000: asset, its transfers and its timeline, ACCESS EXCLUSIVE, before any read or ALTER,
-- so no transfer lands between the column and its backfill. Atomic: explicit BEGIN/COMMIT.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "asset", "asset_transfer", "asset_timeline_entry" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "asset" ADD COLUMN "commissioned_for_organization_id" TEXT;

UPDATE "asset" a
   SET "commissioned_for_organization_id" = a."organization_id"
 WHERE a."commissioned_at" IS NOT NULL
   AND a."ownership_generation" = 0
   AND NOT EXISTS (SELECT 1 FROM "asset_transfer" t WHERE t."asset_id" = a."id");

UPDATE "asset" a
   SET "commissioned_for_organization_id" = a."organization_id"
 WHERE a."commissioned_for_organization_id" IS NULL
   AND a."ownership_generation" > 0
   AND EXISTS (
     SELECT 1
       FROM "asset_timeline_entry" e
      WHERE e."asset_id" = a."id"
        AND e."organization_id" = a."organization_id"
        AND e."source_service" = 'asset-service'
        AND e."event_name" = 'ASSET_ACTIVATED'
        AND e."recorded_at" > (SELECT max(t."transferred_at") FROM "asset_transfer" t
                                WHERE t."asset_id" = a."id"));

COMMIT;
