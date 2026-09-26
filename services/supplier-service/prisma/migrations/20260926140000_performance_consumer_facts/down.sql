-- Reverses 20260926140000_performance_consumer_facts.
--
-- **What a rollback costs.** Every recorded concluded outcome is dropped, and
-- every DISPUTE_ABSENCE fact loses the dispute it resolved — so a later
-- resolution of the same dispute can no longer be told from a second dispute
-- on the same order. The source topics are the only way back, for what they
-- still retain. As with the step-3 rollback, the performance consumer's
-- `processed_event` rows must be cleared before replaying, or the replay
-- finds them and records nothing.
--
-- DROP TABLE fires neither the append-only nor the no-truncate trigger.
-- DROP COLUMN is not an UPDATE, so the append-only trigger does not refuse it.

SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS "performance_concluded_outcome";

DROP FUNCTION IF EXISTS "performance_concluded_outcome_append_only"();

DROP INDEX IF EXISTS "ix_performance_event_dispute";

ALTER TABLE "performance_event" DROP CONSTRAINT IF EXISTS "ck_performance_event_dispute";

ALTER TABLE "performance_event" DROP COLUMN IF EXISTS "dispute_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926140000_performance_consumer_facts';
