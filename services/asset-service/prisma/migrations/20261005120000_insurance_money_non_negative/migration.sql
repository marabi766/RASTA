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
-- Two steps, so no lock that blocks writes is held for a full table scan:
--
--   1. this migration adds each constraint NOT VALID — a catalogue change that
--      takes the table's exclusive lock for milliseconds (lock_timeout bounds
--      the wait) and from then on refuses every new negative write;
--   2. 20261005120100_insurance_money_non_negative_validate validates them,
--      which scans under SHARE UPDATE EXCLUSIVE: reads and writes continue.
--
-- Separate files because PostgreSQL runs a multi-statement script as one
-- implicit transaction: in one file, the exclusive lock taken here would be
-- held through the scan.
--
-- A negative amount already stored is refused here, before anything changes,
-- and never rewritten: which amount was meant — the sign dropped, a credit
-- recorded in the wrong column, a test row — is for an operator to decide, not
-- a migration. The error counts only (no ids or amounts); the HINT gives the
-- query that lists them. Recovery:
-- docs/runbooks/database-bootstrap.md#asset-insurance-money-non-negative
-- =============================================================================
SET LOCAL lock_timeout = '3s';

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
