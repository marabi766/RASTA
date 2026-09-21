-- The decision and the settlement fact, on the claim row.
--
-- `insurance_claim` was created in the initial migration with a status column
-- and nothing to say who moved it, when, or why. Until this migration no code
-- path wrote the table at all — there was no HTTP surface for claims — so the
-- table is empty in every environment that ran the chain, and the CHECK
-- constraints below need no backfill. That is stated here rather than assumed:
-- a constraint added over data it does not describe fails at the ALTER, and
-- this file is the record of why it cannot.
--
-- The constraints encode the state machine's non-negotiable shape:
--
--   * a claim is decided (APPROVED, REJECTED, SETTLED) exactly when it carries
--     a decision timestamp and a decider;
--   * a claim is SETTLED exactly when it carries a settlement timestamp;
--   * a REJECTED claim carries no approved amount — an amount on a rejection
--     is the one combination that could later be read as money owed.
--
-- They compare columns the application sets in the same statement, never a
-- database default against an application clock (D-028 in PROJECT_MEMORY).
SET LOCAL lock_timeout = '3s';

ALTER TABLE "insurance_claim" ADD COLUMN IF NOT EXISTS "decided_at" TIMESTAMP(3);
ALTER TABLE "insurance_claim" ADD COLUMN IF NOT EXISTS "decided_by" TEXT;
ALTER TABLE "insurance_claim" ADD COLUMN IF NOT EXISTS "decision_notes" TEXT;
ALTER TABLE "insurance_claim" ADD COLUMN IF NOT EXISTS "settled_at" TIMESTAMP(3);
ALTER TABLE "insurance_claim" ADD COLUMN IF NOT EXISTS "settlement_reference" TEXT;

ALTER TABLE "insurance_claim"
    ADD CONSTRAINT "ck_claim_decided_iff_decision_recorded"
    CHECK (
        ("status" IN ('APPROVED', 'REJECTED', 'SETTLED'))
        = ("decided_at" IS NOT NULL AND "decided_by" IS NOT NULL)
    );

ALTER TABLE "insurance_claim"
    ADD CONSTRAINT "ck_claim_settled_iff_settlement_recorded"
    CHECK (("status" = 'SETTLED') = ("settled_at" IS NOT NULL));

ALTER TABLE "insurance_claim"
    ADD CONSTRAINT "ck_claim_rejected_has_no_approved_amount"
    CHECK ("status" <> 'REJECTED' OR "approved_amount_minor" IS NULL);

-- The list a dossier reads: every claim on one machine, newest incident first.
CREATE INDEX IF NOT EXISTS "insurance_claim_asset_id_incident_at_idx"
    ON "insurance_claim"("asset_id", "incident_at" DESC);
