-- Reverses 20261005120000_fleet_availability_idempotency (EXP-002 slice 7).
--
-- Roll the code back first: the declaration path claims and completes rows here.
-- Dropping the table forgets every live key, so a client retry within the
-- retention window declares again — the behaviour before this change.
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "idempotency_key";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005120000_fleet_availability_idempotency';
