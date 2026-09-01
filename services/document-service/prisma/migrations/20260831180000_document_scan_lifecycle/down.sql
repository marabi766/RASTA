-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration added and restores the one constraint it
-- replaced, in the order PostgreSQL requires: constraints before the columns
-- they reference, then the index, then the columns.
--
-- **What reversing costs.** The scan queue's memory goes with it. Attempt
-- counts, failure reasons, retry schedules and worker leases are dropped, so
-- every document still `PENDING` looks freshly queued to the worker that comes
-- back after the forward migration is re-applied — it will re-scan them, which
-- is correct but not free. The quarantine record goes too: a document stays
-- `INFECTED` and therefore stays undownloadable, but *when* it was quarantined
-- and under which policy is no longer on the row. The verdicts themselves —
-- `scan_state`, `scan_engine`, `scan_version`, `scan_signature`, `scanned_at`
-- — are untouched, because they predate this migration and are not its to
-- destroy.
--
-- `ck_document_signature_only_when_infected` is restored to the init
-- migration's exact text rather than left dropped. A down script that removes
-- a constraint it merely replaced leaves the table quietly weaker than the
-- schema it claims to have returned to.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

ALTER TABLE "document" DROP CONSTRAINT IF EXISTS "ck_document_scan_lease_only_when_pending";
ALTER TABLE "document" DROP CONSTRAINT IF EXISTS "ck_document_scan_lease_complete";
ALTER TABLE "document" DROP CONSTRAINT IF EXISTS "ck_document_scan_attempts_non_negative";
ALTER TABLE "document" DROP CONSTRAINT IF EXISTS "ck_document_failure_reason_only_when_failed";
ALTER TABLE "document" DROP CONSTRAINT IF EXISTS "ck_document_infected_is_quarantined";
ALTER TABLE "document" DROP CONSTRAINT IF EXISTS "ck_document_quarantine_complete";

DROP INDEX IF EXISTS "ix_document_scan_queue";

ALTER TABLE "document" DROP COLUMN IF EXISTS "quarantine_reason";
ALTER TABLE "document" DROP COLUMN IF EXISTS "quarantined_at";
ALTER TABLE "document" DROP COLUMN IF EXISTS "scan_lease_expires_at";
ALTER TABLE "document" DROP COLUMN IF EXISTS "scan_lease_owner";
ALTER TABLE "document" DROP COLUMN IF EXISTS "scan_next_attempt_at";
ALTER TABLE "document" DROP COLUMN IF EXISTS "scan_failure_reason";
ALTER TABLE "document" DROP COLUMN IF EXISTS "scan_attempts";
ALTER TABLE "document" DROP COLUMN IF EXISTS "scan_queued_at";
ALTER TABLE "document" DROP COLUMN IF EXISTS "scan_signature_version";

-- Back to the init migration's wording, character for character.
ALTER TABLE "document" DROP CONSTRAINT IF EXISTS "ck_document_signature_only_when_infected";
ALTER TABLE "document"
  ADD CONSTRAINT "ck_document_signature_only_when_infected"
  CHECK ("scan_signature" IS NULL OR "scan_state" = 'INFECTED');

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260831180000_document_scan_lifecycle';
