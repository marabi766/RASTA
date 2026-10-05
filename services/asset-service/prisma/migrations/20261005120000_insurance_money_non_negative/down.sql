-- Reverses 20261005120000_insurance_money_non_negative. Roll back
-- 20261005120100_insurance_money_non_negative_validate first.
--
-- The database then accepts a negative premium, insured value, claimed or
-- approved amount again; the API's amountMinorSchema still refuses one, so only
-- a write that bypasses the API can store it. Dropping a constraint is a
-- catalogue change: its exclusive lock is held for milliseconds, and
-- lock_timeout bounds the wait for it. Nothing in the data changes.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "insurance_claim" DROP CONSTRAINT IF EXISTS "ck_claim_approved_amount_non_negative";
ALTER TABLE "insurance_claim" DROP CONSTRAINT IF EXISTS "ck_claim_claimed_amount_non_negative";
ALTER TABLE "insurance_policy" DROP CONSTRAINT IF EXISTS "ck_policy_insured_value_non_negative";
ALTER TABLE "insurance_policy" DROP CONSTRAINT IF EXISTS "ck_policy_premium_non_negative";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005120000_insurance_money_non_negative';
