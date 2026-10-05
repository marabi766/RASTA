-- Reverses 20261004120000_payment_resolution_intent_index. Drops the index
-- only; no resolution row is touched.
--
-- This script is one transaction (it must also delete its own ledger row, and
-- CONCURRENTLY cannot share a script), so the drop below takes the table's
-- exclusive lock. Dropping an index is a catalogue change and the lock is held
-- for milliseconds, but it queues behind any long transaction on the table and
-- everything queues behind it; lock_timeout bounds that wait. To take no such
-- lock, run this first on its own — the IF EXISTS below then finds nothing:
--
--   DROP INDEX CONCURRENTLY IF EXISTS "ix_payment_resolution_org_intent";
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS "ix_payment_resolution_org_intent";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004120000_payment_resolution_intent_index';
