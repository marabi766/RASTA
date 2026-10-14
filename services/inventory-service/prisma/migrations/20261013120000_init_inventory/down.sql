-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created: the triggers and their functions,
-- then the tables children first, then the enums (which cannot be dropped while
-- a column uses them). Indexes, foreign keys and CHECK constraints go with their
-- tables; the generated `available_quantity` column goes with `stock_item`.
--
-- **This destroys every warehouse, stock balance, movement and reservation this
-- service has stored.** Anything already published from the outbox has left:
-- dropping the table cannot recall it, and audit-service keeps its own copy of
-- every event it received — but no other service holds the balances, so a
-- reversal on a database with real stock is a restore from backup, not this file.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_stock_reservation_ledger_check" ON "stock_reservation";
DROP TRIGGER IF EXISTS "tg_stock_reservation_no_truncate" ON "stock_reservation";
DROP TRIGGER IF EXISTS "tg_stock_reservation_guard" ON "stock_reservation";
DROP TRIGGER IF EXISTS "tg_stock_movement_chain" ON "stock_movement";
DROP TRIGGER IF EXISTS "tg_stock_movement_no_truncate" ON "stock_movement";
DROP TRIGGER IF EXISTS "tg_stock_movement_append_only" ON "stock_movement";
DROP TRIGGER IF EXISTS "tg_stock_item_ledger_check" ON "stock_item";
DROP TRIGGER IF EXISTS "tg_stock_item_no_truncate" ON "stock_item";
DROP TRIGGER IF EXISTS "tg_stock_item_guard" ON "stock_item";
DROP TRIGGER IF EXISTS "tg_warehouse_no_truncate" ON "warehouse";
DROP TRIGGER IF EXISTS "tg_warehouse_guard" ON "warehouse";

DROP FUNCTION IF EXISTS "stock_reservation_ledger_check"();
DROP FUNCTION IF EXISTS "stock_reservation_guard"();
DROP FUNCTION IF EXISTS "stock_movement_chain"();
DROP FUNCTION IF EXISTS "stock_movement_append_only"();
DROP FUNCTION IF EXISTS "stock_item_ledger_check"();
DROP FUNCTION IF EXISTS "stock_item_guard"();
DROP FUNCTION IF EXISTS "warehouse_guard"();

DROP TABLE IF EXISTS "outbox_stream_sequence";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "idempotency_key";
DROP TABLE IF EXISTS "stock_movement";
DROP TABLE IF EXISTS "stock_reservation";
DROP TABLE IF EXISTS "stock_item";
DROP TABLE IF EXISTS "warehouse";

DROP TYPE IF EXISTS "StockReservationStatus";
DROP TYPE IF EXISTS "StockMovementType";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261013120000_init_inventory';
