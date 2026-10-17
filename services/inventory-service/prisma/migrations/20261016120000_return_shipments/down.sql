-- =============================================================================
-- Reverse of `migration.sql` (RUN-005 PR 2).
--
-- Drops the triggers and their functions, then the three tables children first.
-- Indexes, foreign keys and CHECK constraints go with their tables. Nothing of
-- the stock, reservation or forward-shipment schema is touched.
--
-- **This destroys every return shipment, line and tracking event this service has
-- stored.** The RETURN_SHIPMENT_* events already published have left through the
-- outbox and audit-service keeps its own copy, but the tracking history itself is
-- held nowhere else: on a database with real return shipments a reversal is a
-- restore from backup, not this file.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_return_tracking_event_no_truncate" ON "return_tracking_event";
DROP TRIGGER IF EXISTS "tg_return_tracking_event_guard" ON "return_tracking_event";
DROP TRIGGER IF EXISTS "tg_return_shipment_line_no_truncate" ON "return_shipment_line";
DROP TRIGGER IF EXISTS "tg_return_shipment_line_guard" ON "return_shipment_line";
DROP TRIGGER IF EXISTS "tg_return_shipment_history_check" ON "return_shipment";
DROP TRIGGER IF EXISTS "tg_return_shipment_no_truncate" ON "return_shipment";
DROP TRIGGER IF EXISTS "tg_return_shipment_guard" ON "return_shipment";

DROP FUNCTION IF EXISTS "return_tracking_event_guard"();
DROP FUNCTION IF EXISTS "return_shipment_line_guard"();
DROP FUNCTION IF EXISTS "return_shipment_history_check"();
DROP FUNCTION IF EXISTS "return_shipment_guard"();

DROP TABLE IF EXISTS "return_tracking_event";
DROP TABLE IF EXISTS "return_shipment_line";
DROP TABLE IF EXISTS "return_shipment";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016120000_return_shipments';
