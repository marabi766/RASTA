-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created: the append-only triggers and their
-- function, then the two tables. Indexes and CHECK constraints go with their tables.
--
-- **This destroys every fact this service has projected.** A fact is rebuilt only
-- by replaying its event, and domain topics keep seven days (docs/07 § 7.2): a
-- completion older than that is gone from analytics for good (ADR-071 § 2 (7),
-- Q-142). The producer still holds its own record; nothing here was a source of
-- truth for anyone else.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_fact_maintenance_no_truncate" ON "fact_maintenance";
DROP TRIGGER IF EXISTS "tg_fact_maintenance_append_only" ON "fact_maintenance";
DROP FUNCTION IF EXISTS "fact_maintenance_append_only"();

DROP TABLE IF EXISTS "fact_maintenance";
DROP TABLE IF EXISTS "processed_event";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017140000_init_analytics';
