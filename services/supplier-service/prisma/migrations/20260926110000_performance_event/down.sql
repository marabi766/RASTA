-- Reverses 20260926110000_performance_event.
--
-- **What a rollback costs.** Every counted performance fact is dropped. The
-- store is the only source a score can be rebuilt from (ADR-052 § 12), so after
-- this rollback the history has to be re-consumed from the source topics — and
-- whatever those topics no longer retain is gone. `processed_event` is left
-- untouched: rows there would then claim a consumer counted facts that no
-- longer exist, which is why an operator rolling this back must also clear the
-- performance consumers' `processed_event` rows before replaying.
--
-- DROP TABLE fires neither the append-only nor the no-truncate trigger.

SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS "performance_event";

DROP FUNCTION IF EXISTS "performance_event_append_only"();

DROP TYPE IF EXISTS "PerformanceOutcomeKind";
DROP TYPE IF EXISTS "ResponsibilityAttribution";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926110000_performance_event';
