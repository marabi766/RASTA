-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created: the triggers and their functions,
-- then the tables, children first. Indexes, the foreign key and the CHECK
-- constraints go with their tables. No enum to drop: every status is text.
--
-- **This destroys every demand and aggregation this service has stored.** Anything
-- already published from the outbox has left: dropping the table cannot recall it,
-- and audit-service keeps its own copy of every event it received — but no other
-- service holds the demands themselves, so a reversal on a database with real
-- demands is a restore from backup, not this file.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_demand_request_totals_check" ON "demand_request";
DROP TRIGGER IF EXISTS "tg_demand_aggregation_totals_check" ON "demand_aggregation";
DROP TRIGGER IF EXISTS "tg_demand_request_no_truncate" ON "demand_request";
DROP TRIGGER IF EXISTS "tg_demand_request_guard" ON "demand_request";
DROP TRIGGER IF EXISTS "tg_demand_aggregation_no_truncate" ON "demand_aggregation";
DROP TRIGGER IF EXISTS "tg_demand_aggregation_guard" ON "demand_aggregation";

DROP FUNCTION IF EXISTS "demand_aggregation_totals_check"();
DROP FUNCTION IF EXISTS "demand_request_guard"();
DROP FUNCTION IF EXISTS "demand_aggregation_guard"();

DROP TABLE IF EXISTS "outbox_stream_sequence";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "idempotency_key";
DROP TABLE IF EXISTS "demand_request";
DROP TABLE IF EXISTS "demand_aggregation";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016200000_init_procurement';
