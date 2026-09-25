-- Splits the one dispatch-block field into independent causes (L3-02).
--
-- `dispatch_blocked_reason`/`dispatch_blocked_at` held whichever safety block
-- fired last, inspection or insurance, and MAINTENANCE_COMPLETED cleared it
-- unconditionally. A repair — which resolves a failed inspection, not a
-- lapsed policy — therefore also re-armed an asset whose insurance had
-- expired, and a later block overwrote the reason of an earlier one.
--
-- Inspection keeps a reason/at pair, plus the instant of the latest completed
-- repair, so a failure and a repair are ordered by when they happened rather
-- than by when fleet consumed them. Insurance becomes a set of lapsed
-- coverages plus the recorded policy windows per coverage, resolved at read
-- time (src/fleet/dispatch-blocks.ts).
--
-- Backfill is exact, not a guess: the consumer only ever wrote two literal
-- reason strings. An existing insurance block did not record which coverage
-- lapsed, so it becomes `UNKNOWN`, which any policy in force resolves — the
-- same answer the old single field gave, and no worse (docs/24 Q-65). No
-- recorded policy windows exist yet (fleet never consumed INSURANCE_RECORDED
-- before this change), so `insurance_cover` starts empty for every row.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" ADD COLUMN IF NOT EXISTS "inspection_blocked_reason" TEXT;
ALTER TABLE "asset_ref" ADD COLUMN IF NOT EXISTS "inspection_blocked_at" TIMESTAMP(3);
ALTER TABLE "asset_ref" ADD COLUMN IF NOT EXISTS "inspection_resolved_at" TIMESTAMP(3);
ALTER TABLE "asset_ref" ADD COLUMN IF NOT EXISTS "insurance_lapsed_coverages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "asset_ref" ADD COLUMN IF NOT EXISTS "insurance_lapsed_at" TIMESTAMP(3);
ALTER TABLE "asset_ref" ADD COLUMN IF NOT EXISTS "insurance_cover" JSONB NOT NULL DEFAULT '{}';

UPDATE "asset_ref"
   SET "inspection_blocked_reason" = "dispatch_blocked_reason",
       "inspection_blocked_at" = "dispatch_blocked_at"
 WHERE "dispatch_blocked_reason" = 'The most recent technical inspection failed';

UPDATE "asset_ref"
   SET "insurance_lapsed_coverages" = ARRAY['UNKNOWN']::TEXT[],
       "insurance_lapsed_at" = "dispatch_blocked_at"
 WHERE "dispatch_blocked_reason" = 'The insurance policy has expired';

ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "dispatch_blocked_reason";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "dispatch_blocked_at";
