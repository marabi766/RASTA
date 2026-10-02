-- =============================================================================
-- construction-service — opening the bids (CON-002 PR 8, ADR-065 § 1, ADR-066 § 2-5)
--
-- When and by whom a tender's bids were opened (CLOSED → EVALUATING). The opening is
-- the one moment the tender's private key is unwrapped for the owner; this is the
-- record that it happened.
-- =============================================================================

-- AlterTable
ALTER TABLE "tender" ADD COLUMN "opened_at" TIMESTAMPTZ(3),
ADD COLUMN "opened_by" TEXT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- Opening names who and when, both or neither; only a closed tender is opened, and
-- never before it was closed.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_opening_complete"
  CHECK (num_nonnulls("opened_at", "opened_by") IN (0, 2)
         AND ("opened_by" IS NULL OR btrim("opened_by") <> '')
         AND ("opened_at" IS NULL OR ("closed_at" IS NOT NULL AND "opened_at" >= "closed_at")));
