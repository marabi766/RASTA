-- Ownership generation (PR #108 review round 2 #5).
--
-- Whether an insurance policy was recorded by the asset's current owner was
-- decided by comparing its created_at with the latest transfer's
-- transferred_at. Both are TIMESTAMP(3): a policy written just before a
-- transfer and the transfer itself can round to the same millisecond, and
-- then the previous owner's policy reads as the new owner's. With a narrowed
-- INSURANCE_COVERAGES_FOLLOWING_VEHICLE, that lets the new owner activate on a
-- coverage configured not to follow the vehicle.
--
-- A counter cannot tie. asset.ownership_generation is 0 for the organization
-- that registered the asset and incremented by each transfer, in its
-- compare-and-set, under the row lock. insurance_policy.ownership_generation
-- is stamped from the asset row read under the same lock when the policy is
-- recorded.
--
-- Existing rows are backfilled from the rule they were judged by until now:
-- an asset's generation is its number of transfers, and a policy's is the
-- number of that asset's transfers at or before its created_at (created_at >=
-- transferred_at meant "the new owner's"). A legacy policy that tied its
-- transfer to the millisecond keeps the reading it already had; every policy
-- recorded from now on is exact.
--
-- Locked like 20260925110000: asset first, ACCESS EXCLUSIVE, before any read
-- or ALTER (PR #108 round 3 #1). No transfer or policy lands between the two
-- backfills, and no writer holding an asset row FOR SHARE can deadlock the
-- ALTER. Atomic because of the explicit BEGIN/COMMIT.
--
-- Edited after 8ac4229 in round 3 (lock mode only). Never on main, and no
-- persistent environment applied it; CI and development databases are
-- disposable.

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "asset", "insurance_policy", "asset_transfer" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "asset" ADD COLUMN "ownership_generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "insurance_policy" ADD COLUMN "ownership_generation" INTEGER NOT NULL DEFAULT 0;

UPDATE "asset" a
   SET "ownership_generation" = t.transfers
  FROM (SELECT "asset_id", count(*)::integer AS transfers
          FROM "asset_transfer" GROUP BY "asset_id") t
 WHERE t."asset_id" = a."id";

UPDATE "insurance_policy" p
   SET "ownership_generation" = (
         SELECT count(*)::integer FROM "asset_transfer" t
          WHERE t."asset_id" = p."asset_id" AND t."transferred_at" <= p."created_at")
 WHERE EXISTS (SELECT 1 FROM "asset_transfer" t WHERE t."asset_id" = p."asset_id");

COMMIT;
