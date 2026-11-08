-- Reverses 20261106120000_saga_monitor_clock.
--
-- Roll the code back BEFORE this runs: the previous code neither reads nor writes
-- the table. A reader still running fails its sample without it, so its gauges
-- are withdrawn and the unresolved-money alert fires as unknown, never silent.
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "saga_monitor_clock";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106120000_saga_monitor_clock';
