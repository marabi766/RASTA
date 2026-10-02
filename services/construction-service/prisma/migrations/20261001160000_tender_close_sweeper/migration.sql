-- =============================================================================
-- construction-service — closing a tender (CON-002 PR 7, ADR-065 § 3)
--
-- When and by whom a tender was closed, and the lease and fencing token a sweeper
-- holds while it closes one. The lease is housekeeping, not state: claiming does not
-- touch `version` or `updated_at`, so an owner's expectedVersion is never disturbed.
-- =============================================================================

-- AlterTable
ALTER TABLE "tender" ADD COLUMN "closed_at" TIMESTAMPTZ(3),
ADD COLUMN "closed_by" TEXT,
ADD COLUMN "close_lease_until" TIMESTAMPTZ(3),
ADD COLUMN "close_fence" TEXT,
ADD COLUMN "close_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "close_next_attempt_at" TIMESTAMPTZ(3);

-- SQL-only (Prisma cannot express a partial index): the sweeper's scan reads
-- PUBLISHED tenders by deadline and nothing else. The queries must spell the
-- predicate the same way (`"status" = 'PUBLISHED'`, the enum comparison, never
-- `"status"::text = …`) or the planner cannot use it; the integration suite
-- EXPLAINs both.
CREATE INDEX "ix_tender_close_due" ON "tender"("bid_closing_at", "id") WHERE "status" = 'PUBLISHED';

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- Closing names who and when, both or neither, and never before the deadline.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_closure_complete"
  CHECK (num_nonnulls("closed_at", "closed_by") IN (0, 2)
         AND ("closed_by" IS NULL OR btrim("closed_by") <> '')
         AND ("closed_at" IS NULL OR "bid_closing_at" IS NULL OR "closed_at" >= "bid_closing_at"));

-- The lease and its token are one fact: held together, or not at all; and only a
-- tender still waiting to be closed holds one, or a retry schedule.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_close_lease"
  CHECK (("close_lease_until" IS NULL) = ("close_fence" IS NULL)
         AND ("close_fence" IS NULL OR "status"::text = 'PUBLISHED'));

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_close_attempts"
  CHECK ("close_attempts" >= 0
         AND ("status"::text = 'PUBLISHED'
              OR ("close_attempts" = 0 AND "close_next_attempt_at" IS NULL)));

-- Whatever moves a tender out of PUBLISHED — cancel, close, any edge added later —
-- drops the sweeper's claim and retry schedule in the same UPDATE, so the checks
-- above can never reject a valid transition and a claim can never outlive the
-- state it was taken for. BEFORE triggers run ahead of the CHECKs.
CREATE FUNCTION "tender_leave_published_clears_close_claim"() RETURNS trigger AS $$
BEGIN
  NEW."close_lease_until" := NULL;
  NEW."close_fence" := NULL;
  NEW."close_attempts" := 0;
  NEW."close_next_attempt_at" := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_leave_published_clears_close_claim"
  BEFORE UPDATE OF "status" ON "tender"
  FOR EACH ROW
  WHEN (OLD."status"::text = 'PUBLISHED' AND NEW."status"::text <> 'PUBLISHED')
  EXECUTE FUNCTION "tender_leave_published_clears_close_claim"();
