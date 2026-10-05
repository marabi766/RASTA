-- Reverses 20261005120100_insurance_money_non_negative_validate: the four
-- constraints go back to NOT VALID, the state the previous migration left them
-- in. PostgreSQL has no "unvalidate", so each is dropped and added again NOT
-- VALID in one statement — a catalogue change, no scan, its exclusive lock held
-- for milliseconds and bounded by lock_timeout. New negative writes stay
-- refused throughout; nothing in the data changes. Not a recovery step: a run
-- of the migration that refused changed nothing and needs no rollback
-- (docs/runbooks/database-bootstrap.md#asset-insurance-money-non-negative).
SET LOCAL lock_timeout = '3s';

ALTER TABLE "insurance_policy"
    DROP CONSTRAINT IF EXISTS "ck_policy_premium_non_negative",
    ADD CONSTRAINT "ck_policy_premium_non_negative" CHECK ("premium_minor" >= 0) NOT VALID,
    DROP CONSTRAINT IF EXISTS "ck_policy_insured_value_non_negative",
    ADD CONSTRAINT "ck_policy_insured_value_non_negative" CHECK ("insured_value_minor" >= 0) NOT VALID;

ALTER TABLE "insurance_claim"
    DROP CONSTRAINT IF EXISTS "ck_claim_claimed_amount_non_negative",
    ADD CONSTRAINT "ck_claim_claimed_amount_non_negative" CHECK ("claimed_amount_minor" >= 0) NOT VALID,
    DROP CONSTRAINT IF EXISTS "ck_claim_approved_amount_non_negative",
    ADD CONSTRAINT "ck_claim_approved_amount_non_negative" CHECK ("approved_amount_minor" >= 0) NOT VALID;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005120100_insurance_money_non_negative_validate';
