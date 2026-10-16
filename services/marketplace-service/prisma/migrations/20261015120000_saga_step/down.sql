-- Reverses 20261015120000_saga_step.
--
-- Roll the code back BEFORE this runs: the previous code neither reads nor
-- writes the table. Dropping it loses only the replay records, so an activity
-- retry that is in flight at that moment is judged by the order's current
-- status again — the behaviour before this migration (docs/23 D-053).
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "saga_step";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015120000_saga_step';
