-- Reverses 20261105130000_saga_unconfirmed_call.
--
-- Roll the code back BEFORE this runs: the previous code neither reads nor writes
-- the table. Dropping it loses the record of any release still unconfirmed, so
-- list the open rows first (docs/runbooks/marketplace-saga-deploy.md).
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "saga_unconfirmed_call";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105130000_saga_unconfirmed_call';
