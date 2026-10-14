-- The replica's insurance invalidation epoch (#240 round 11).
--
-- `asset_ref.insurance_epoch` is moved by `insurance:clear-transferred` alone,
-- and by it ALWAYS: every transferred replica a run targets gets it incremented,
-- whether or not the run had anything to empty. Every verification of an
-- INSURANCE_RECORDED (live or parked) reads it with the insurance revision
-- before asset-service is asked, and its decision is applied only if both are
-- unchanged under the asset's lock.
--
-- The revision alone was not enough: it moves only when a value changes, and
-- clearing a replica whose windows and retained list are already empty changes
-- nothing. An answer asset-service gave under the previous following rule would
-- then still match it, and add a window the new rule no longer allows.
--
-- Additive with a constant default (no table rewrite). Existing rows start at
-- epoch 0, which nothing in flight has read yet.
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" ADD COLUMN "insurance_epoch" BIGINT NOT NULL DEFAULT 0;

COMMIT;
