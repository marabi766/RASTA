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
-- Backfill (conservative, nothing else rewritten): an asset with `commissioned_at` that has never
-- been transferred (ownership_generation = 0 and no transfer row) is commissioned for its current
-- owner. Every transferred asset stays NULL (round 8): under the old transfer code the previous
-- owner's document reference moved to the recipient, so a recipient's `ASSET_ACTIVATED` line proves
-- when it activated, not whose document it used; once the runbook returns the reference to the
-- previous owner that line is no proof of the recipient's own dossier. The current owner attaches
-- its dossier before the asset returns to service, and that activation sets the column.
--
-- Locked like 20260926000000: asset and its transfers, ACCESS EXCLUSIVE, before any read or ALTER,
-- so no transfer lands between the column and its backfill. Atomic: explicit BEGIN/COMMIT.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "asset", "asset_transfer" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "asset" ADD COLUMN "commissioned_for_organization_id" TEXT;

UPDATE "asset" a
   SET "commissioned_for_organization_id" = a."organization_id"
 WHERE a."commissioned_at" IS NOT NULL
   AND a."ownership_generation" = 0
   AND NOT EXISTS (SELECT 1 FROM "asset_transfer" t WHERE t."asset_id" = a."id");

COMMIT;
