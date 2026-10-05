-- =============================================================================
-- asset-service — validates the four non-negative CHECK constraints the previous
-- migration added NOT VALID (audit L7-36).
--
-- VALIDATE CONSTRAINT scans each table under SHARE UPDATE EXCLUSIVE, which
-- blocks neither reads nor writes; no new negative amount can arrive meanwhile,
-- because the constraints already refuse new writes.
--
-- The same refusal as the previous migration runs first. Through the shipped
-- chain it cannot fire: that migration checked and added the constraints under
-- one lock, so no row it did not see sits under them (#222 r1). It is there
-- for a database that reached NOT VALID another way — the constraints dropped
-- and re-added by hand, say — so that a negative amount is refused in words,
-- as the stored amount it is, rather than as a raw check violation, and
-- nothing is rewritten.
-- Recovery: docs/runbooks/database-bootstrap.md#asset-insurance-money-non-negative
-- =============================================================================
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
      'insurance money: negative amounts stored (premium_minor %, insured_value_minor %, claimed_amount_minor %, approved_amount_minor %); refusing to validate the non-negative CHECK constraints',
      premium, insured, claimed, approved
      USING HINT = 'List them with: SELECT id FROM insurance_policy WHERE premium_minor < 0 OR insured_value_minor < 0; SELECT id FROM insurance_claim WHERE claimed_amount_minor < 0 OR approved_amount_minor < 0; correct each by a reviewed data fix (this migration never rewrites them), then follow docs/runbooks/database-bootstrap.md#asset-insurance-money-non-negative.';
  END IF;
END $$;

ALTER TABLE "insurance_policy" VALIDATE CONSTRAINT "ck_policy_premium_non_negative";
ALTER TABLE "insurance_policy" VALIDATE CONSTRAINT "ck_policy_insured_value_non_negative";
ALTER TABLE "insurance_claim" VALIDATE CONSTRAINT "ck_claim_claimed_amount_non_negative";
ALTER TABLE "insurance_claim" VALIDATE CONSTRAINT "ck_claim_approved_amount_non_negative";
