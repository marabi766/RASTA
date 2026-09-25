-- Reverses 20260925000000_split_dispatch_block_causes.
--
-- Roll the code back first: the consumer and the availability/assignment
-- reads all target the split columns, and a running service against the
-- reverted schema would write to columns that no longer exist.
--
-- The old schema has one reason field, and the old code clears it on any
-- completed repair. Two states cannot be carried back into it without losing
-- a safety fact, so the rollback refuses them and changes nothing:
--
--   * Blocked on inspection AND insurance. One field keeps one cause. After
--     the old code clears it on a repair, an uninsured machine would be
--     dispatchable again.
--   * Lapsed coverages AND recorded policy windows. The windows are what say
--     whether the lapse is answered. Without them, the old schema can only
--     say "blocked", which is wrong for a machine whose renewal is in force.
--
-- Resolve those rows by hand before rolling back. Find them with:
--
--   SELECT id, inspection_blocked_reason, insurance_lapsed_coverages, insurance_cover
--   FROM asset_ref
--   WHERE cardinality(insurance_lapsed_coverages) > 0
--     AND (inspection_blocked_reason IS NOT NULL OR insurance_cover <> '{}'::jsonb);
--
-- Every other row carries back exactly. Recorded policy windows on rows with
-- no lapse are dropped: the old code never read them. The next up-migration
-- starts them empty again, so a lapse consumed after that is answered only by
-- a policy recorded after it.
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  unsafe integer;
BEGIN
  SELECT count(*) INTO unsafe
  FROM "asset_ref"
  WHERE cardinality("insurance_lapsed_coverages") > 0
    AND ("inspection_blocked_reason" IS NOT NULL OR "insurance_cover" <> '{}'::jsonb);
  IF unsafe > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back 20260925000000_split_dispatch_block_causes: % asset_ref row(s) hold an insurance lapse together with an inspection block or recorded policy windows, and the old single-reason schema would lose one of them. See the query in down.sql.',
      unsafe;
  END IF;
END $$;

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
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "inspection_resolved_at";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "insurance_lapsed_coverages";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "insurance_lapsed_at";
ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "insurance_cover";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925000000_split_dispatch_block_causes';
