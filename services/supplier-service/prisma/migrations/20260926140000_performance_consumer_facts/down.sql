-- Reverses 20260926140000_performance_consumer_facts.
--
-- **What a rollback costs.** Two kinds of recorded effect cannot survive the
-- schema this rolls back to, and both are removed together with the
-- performance consumer's `processed_event` markers for them — so the
-- `processed_event` table never claims an effect that no longer exists, and a
-- replay after re-applying the migration records them again (Codex review of
-- #126, finding 3):
--
--   * every concluded outcome — its table is dropped;
--   * every DISPUTE_ABSENCE fact that carries a dispute id — the column is
--     dropped, and a fact without the dispute it resolved could never again
--     be matched by the redelivery comparison, so every replay of it would be
--     refused. The rows go, and the replay brings them back whole.
--
-- Every other fact (ON_TIME, CUSTOMER_SATISFACTION, CANCELLATION_ABSENCE, and
-- DISPUTE_ABSENCE rows from before this migration) is untouched, and so are
-- their markers. Whatever the source topic no longer retains is not coming
-- back: take this rollback only with that in mind.
--
-- Deleting from the append-only store needs its row trigger lifted, for that
-- one statement and inside one DO block, so the lift, the deletes and the
-- re-enable are a single statement and cannot be left half-done. A dispute
-- fact already cited by a score snapshot refuses the delete
-- (`performance_score_source_event_event_fkey`) and the whole rollback fails:
-- a rollback must not orphan a snapshot's provenance.
--
-- DROP TABLE fires neither the append-only nor the no-truncate trigger.
-- DROP COLUMN is not an UPDATE, so the append-only trigger does not refuse it.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  DELETE FROM "processed_event"
   WHERE "consumer_name" = 'supplier-service.performance'
     AND "event_id" IN (SELECT "source_event_id" FROM "performance_concluded_outcome");

  DELETE FROM "processed_event"
   WHERE "consumer_name" = 'supplier-service.performance'
     AND "event_id" IN (
       SELECT "source_event_id" FROM "performance_event" WHERE "dispute_id" IS NOT NULL
     );

  ALTER TABLE "performance_event" DISABLE TRIGGER "trg_performance_event_append_only";
  DELETE FROM "performance_event" WHERE "dispute_id" IS NOT NULL;
  ALTER TABLE "performance_event" ENABLE TRIGGER "trg_performance_event_append_only";
END
$$;

DROP TABLE IF EXISTS "performance_concluded_outcome";

DROP FUNCTION IF EXISTS "performance_concluded_outcome_append_only"();

DROP INDEX IF EXISTS "ix_performance_event_dispute";

ALTER TABLE "performance_event" DROP CONSTRAINT IF EXISTS "ck_performance_event_dispute";

ALTER TABLE "performance_event" DROP COLUMN IF EXISTS "dispute_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926140000_performance_consumer_facts';
