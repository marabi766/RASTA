-- =============================================================================
-- Reverse of `migration.sql` (COM-006 PR 2).
--
-- Drops the triggers and their functions, then the three tables children first.
-- Indexes, foreign keys and CHECK constraints go with their tables. Nothing of
-- PR 1 (warehouses, stock, reservations, the outbox) is touched.
--
-- **This destroys every shipment, leg and tracking event this service has
-- stored.** The SHIPMENT_* events already published have left through the
-- outbox and audit-service keeps its own copy, but the tracking history itself
-- is held nowhere else: on a database with real shipments a reversal is a
-- restore from backup, not this file.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_tracking_event_no_truncate" ON "tracking_event";
DROP TRIGGER IF EXISTS "tg_tracking_event_guard" ON "tracking_event";
DROP TRIGGER IF EXISTS "tg_shipment_leg_no_truncate" ON "shipment_leg";
DROP TRIGGER IF EXISTS "tg_shipment_leg_guard" ON "shipment_leg";
DROP TRIGGER IF EXISTS "tg_shipment_history_check" ON "shipment";
DROP TRIGGER IF EXISTS "tg_shipment_no_truncate" ON "shipment";
DROP TRIGGER IF EXISTS "tg_shipment_guard" ON "shipment";

DROP FUNCTION IF EXISTS "tracking_event_guard"();
DROP FUNCTION IF EXISTS "shipment_leg_guard"();
DROP FUNCTION IF EXISTS "shipment_history_check"();
DROP FUNCTION IF EXISTS "shipment_guard"();

DROP TABLE IF EXISTS "tracking_event";
DROP TABLE IF EXISTS "shipment_leg";
DROP TABLE IF EXISTS "shipment";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261014120000_shipments';
