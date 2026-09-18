-- Reverses 20260911130000_security_event_outbox_aggregation (ADR-053 § 4,
-- AUD-004 Phase C2).
--
-- Roll the code back first: the Phase C1 producer writes one row per refusal
-- and neither reads nor writes these columns.
--
-- Lossy for undelivered aggregates: an unpublished row with
-- `occurrence_count > 1` would afterwards be published as a single occurrence.
-- Drain first — a closed window is claimable at once, an open one within
-- `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS` — until
-- `SELECT count(*) FROM security_event_outbox WHERE published_at IS NULL AND occurrence_count > 1`
-- reaches zero. Published rows lose nothing that audit-service does not
-- already hold.

SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS "tg_security_event_outbox_guard" ON "security_event_outbox";
DROP FUNCTION IF EXISTS "security_event_outbox_guard"();

DROP INDEX IF EXISTS "ux_security_event_outbox_open_bucket";
DROP INDEX IF EXISTS "ix_security_event_outbox_closed_windows";

ALTER TABLE "security_event_outbox"
  DROP CONSTRAINT IF EXISTS "ck_security_event_outbox_occurrence_count_range",
  DROP CONSTRAINT IF EXISTS "ck_security_event_outbox_window_bounds",
  DROP CONSTRAINT IF EXISTS "ck_security_event_outbox_occurred_within_window",
  DROP CONSTRAINT IF EXISTS "ck_security_event_outbox_aggregate_needs_window",
  DROP CONSTRAINT IF EXISTS "ck_security_event_outbox_published_was_claimed";

ALTER TABLE "security_event_outbox"
  DROP COLUMN IF EXISTS "occurrence_count",
  DROP COLUMN IF EXISTS "window_started_at",
  DROP COLUMN IF EXISTS "window_ends_at";

-- Prisma will not re-apply a migration whose row is still in its ledger.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260911130000_security_event_outbox_aggregation';
