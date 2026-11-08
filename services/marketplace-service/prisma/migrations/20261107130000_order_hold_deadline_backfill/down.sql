-- Reverses 20261107130000_order_hold_deadline_backfill. Forgets only the record of which
-- deadlines the backfill gave: the deadlines stay on the orders (see the runbook to undo one).
SET LOCAL lock_timeout = '3s';
DROP TABLE IF EXISTS "order_hold_deadline_backfill";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261107130000_order_hold_deadline_backfill';
