-- Reverses 20260925000000_split_dispatch_block_causes.
--
-- Roll the code back first: the consumer and the availability/assignment
-- reads all target the split columns, and a running service against the
-- reverted schema would write to columns that no longer exist.
--
-- The causes cannot all survive a single reason field. Inspection wins the
-- merge — a failed inspection is the platform's stated highest-priority
-- safety fact (docs/events/README.md § Insurance) — so a machine blocked on
-- both loses only the insurance detail in the string, never the block itself.
-- A lapse is carried back as blocked even if a recorded policy currently
-- answers it: the old schema had no way to express "answered", and blocked is
-- the direction that keeps a machine off the road. The recorded policy
-- windows are dropped; the old code never read them.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" ADD COLUMN IF NOT EXISTS "dispatch_blocked_reason" TEXT;
ALTER TABLE "asset_ref" ADD COLUMN IF NOT EXISTS "dispatch_blocked_at" TIMESTAMP(3);

UPDATE "asset_ref"
   SET "dispatch_blocked_reason" = CASE
         WHEN "inspection_blocked_reason" IS NOT NULL THEN "inspection_blocked_reason"
         WHEN cardinality("insurance_lapsed_coverages") > 0 THEN 'The insurance policy has expired'
       END,
       "dispatch_blocked_at" = CASE
         WHEN "inspection_blocked_reason" IS NOT NULL THEN "inspection_blocked_at"
         WHEN cardinality("insurance_lapsed_coverages") > 0 THEN "insurance_lapsed_at"
       END;

ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "inspection_blocked_reason";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "inspection_blocked_at";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "insurance_lapsed_coverages";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "insurance_lapsed_at";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "insurance_cover";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925000000_split_dispatch_block_causes';
