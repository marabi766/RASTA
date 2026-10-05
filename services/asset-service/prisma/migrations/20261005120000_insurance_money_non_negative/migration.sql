-- =============================================================================
-- asset-service — the insurance money columns may not hold a negative amount
-- (audit L7-36).
--
-- insurance_policy.premium_minor, insurance_policy.insured_value_minor,
-- insurance_claim.claimed_amount_minor and insurance_claim.approved_amount_minor
-- are rial minor units (ADR-022). Until now the only guard was the API's
-- amountMinorSchema; a write that reached the database another way could store
-- a negative premium, insured value, claimed or approved amount, and every
-- reader would take it as money. All four columns are nullable ("not stated"),
-- and stay so: a CHECK whose expression is NULL passes.
--
-- Not asset_timeline_entry.amount_minor: the timeline consumer accepts a signed
-- amount from its producers, and whether a producer may report a negative cost
-- is an open owner decision, not this migration's.
--
-- The check and the ALTERs run under one lock, so nothing can slip between
-- them (#222 r1). LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE — both tables in one
-- statement, always in this order — lets reads continue and makes every
-- INSERT, UPDATE and DELETE on them wait until this migration commits. Without
-- it, a negative amount committed between the check and the ALTERs would sit
-- under NOT VALID constraints the validation then refuses, and PostgreSQL
-- checks a NOT VALID constraint on every later UPDATE of that row, whichever
-- column the UPDATE sets: the transfer, the claim review and the expiry sweep
-- would each fail on it.
--
-- Writes wait only for the check's two counts and the catalogue changes. The
-- tables are small: one row per policy or claim a person recorded through the
-- API, nothing generated. Measured on PostgreSQL 16 with 100 000 rows in each
-- (33 MB and 28 MB, far beyond any deployment's), both counts took 25–31 ms
-- warm under this lock. The ALTERs then take ACCESS EXCLUSIVE for
-- milliseconds, blocking reads too. lock_timeout bounds the wait for either
-- lock; a run that times out changes nothing and is simply deployed again.
--
-- The validation is a second file because PostgreSQL runs a multi-statement
-- script as one implicit transaction: here, the ACCESS EXCLUSIVE lock the ALTERs
-- take would be held through its scan. There it scans under SHARE UPDATE
-- EXCLUSIVE, which blocks neither reads nor writes.
--
-- A negative amount already stored is refused here, before anything changes,
-- and never rewritten: which amount was meant — the sign dropped, a credit
-- recorded in the wrong column, a test row — is for an operator to decide, not
-- a migration. The error counts only (no ids or amounts); the HINT gives the
-- query that lists them. Recovery:
-- docs/runbooks/database-bootstrap.md#asset-insurance-money-non-negative
-- =============================================================================
SET LOCAL lock_timeout = '3s';

LOCK TABLE "insurance_policy", "insurance_claim" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  premium      bigint;
  insured      bigint;
  claimed      bigint;
  approved     bigint;
BEGIN
  SELECT count(*) FILTER (WHERE "premium_minor" < 0),
         count(*) FILTER (WHERE "insured_value_minor" < 0)
    INTO premium, insured
    FROM "insurance_policy";
  SELECT count(*) FILTER (WHERE "claimed_amount_minor" < 0),
         count(*) FILTER (WHERE "approved_amount_minor" < 0)
    INTO claimed, approved
    FROM "insurance_claim";
  IF premium + insured + claimed + approved > 0 THEN
    RAISE EXCEPTION
      'insurance money: negative amounts stored (premium_minor %, insured_value_minor %, claimed_amount_minor %, approved_amount_minor %); refusing to add the non-negative CHECK constraints',
      premium, insured, claimed, approved
      USING HINT = 'List them with: SELECT id FROM insurance_policy WHERE premium_minor < 0 OR insured_value_minor < 0; SELECT id FROM insurance_claim WHERE claimed_amount_minor < 0 OR approved_amount_minor < 0; correct each by a reviewed data fix (this migration never rewrites them), then follow docs/runbooks/database-bootstrap.md#asset-insurance-money-non-negative.';
  END IF;
END $$;

ALTER TABLE "insurance_policy"
    ADD CONSTRAINT "ck_policy_premium_non_negative"
    CHECK ("premium_minor" >= 0) NOT VALID;

ALTER TABLE "insurance_policy"
    ADD CONSTRAINT "ck_policy_insured_value_non_negative"
    CHECK ("insured_value_minor" >= 0) NOT VALID;

ALTER TABLE "insurance_claim"
    ADD CONSTRAINT "ck_claim_claimed_amount_non_negative"
    CHECK ("claimed_amount_minor" >= 0) NOT VALID;

ALTER TABLE "insurance_claim"
    ADD CONSTRAINT "ck_claim_approved_amount_non_negative"
    CHECK ("approved_amount_minor" >= 0) NOT VALID;
