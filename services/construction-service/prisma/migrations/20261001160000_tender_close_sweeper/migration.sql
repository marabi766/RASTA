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
ADD COLUMN "close_fence" TEXT;

-- SQL-only (Prisma cannot express a partial index): the sweeper's scan reads
-- PUBLISHED tenders by deadline and nothing else.
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
-- tender still waiting to be closed holds one.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_close_lease"
  CHECK (("close_lease_until" IS NULL) = ("close_fence" IS NULL)
         AND ("close_fence" IS NULL OR "status"::text = 'PUBLISHED'));
