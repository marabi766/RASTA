-- Reverses 20261106130000_saga_unconfirmed_call_command.
--
-- Roll the code back BEFORE this runs: the previous code neither reads nor writes
-- the columns. Rows keep their generation, so the previous code's fence still holds.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "saga_unconfirmed_call" DROP CONSTRAINT IF EXISTS "ck_saga_unconfirmed_call_command_whole";
ALTER TABLE "saga_unconfirmed_call" DROP COLUMN IF EXISTS "episode_generation";
ALTER TABLE "saga_unconfirmed_call" DROP COLUMN IF EXISTS "command_scheduled_at";
ALTER TABLE "saga_unconfirmed_call" DROP COLUMN IF EXISTS "command";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106130000_saga_unconfirmed_call_command';
