-- The replica remembers which ownership generation it last saw a transfer
-- reach and which insurance coverages that transfer let follow the vehicle
-- (#240 round 2, docs/24 Q-101).
--
-- With a required-coverage dispatch rule, an insurance window the new owner did
-- not record must not authorize it unless asset-service lets that coverage
-- follow the vehicle (INSURANCE_COVERAGES_FOLLOWING_VEHICLE). ASSET_TRANSFERRED
-- now carries both facts; the projection keeps only the retained coverages'
-- windows and stores the two values so a late INSURANCE_RECORDED from the
-- previous owner can be told from the new owner's.
--
-- Both columns are additive and nullable/empty by default: a row that has seen
-- no generation-bearing transfer holds NULL and [], and the consumer then has
-- nothing to compare an insurance event against, so it applies it as before.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" ADD COLUMN "ownership_generation" INTEGER;
ALTER TABLE "asset_ref" ADD COLUMN "retained_coverages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMIT;
