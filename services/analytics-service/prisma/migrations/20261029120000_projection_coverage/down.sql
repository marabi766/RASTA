-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops the coverage table with the guards it carries. Unlike a baseline, a recorded coverage
-- start is not evidence anyone else relies on, and losing it fails CLOSED: the next successful
-- consumer start records a LATER instant, so older windows read NO_DATA — never a falsely
-- covered one. Rolling back therefore needs no refusal.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS "tg_projection_coverage_started_at" ON "projection_coverage";
DROP TRIGGER IF EXISTS "tg_projection_coverage_no_truncate" ON "projection_coverage";
DROP TRIGGER IF EXISTS "tg_projection_coverage_append_only" ON "projection_coverage";
DROP FUNCTION IF EXISTS "projection_coverage_started_now"();
DROP FUNCTION IF EXISTS "projection_coverage_append_only"();
DROP TABLE IF EXISTS "projection_coverage";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029120000_projection_coverage';
