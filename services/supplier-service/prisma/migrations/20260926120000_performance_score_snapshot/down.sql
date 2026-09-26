-- Reverses 20260926120000_performance_score_snapshot.
--
-- **What a rollback costs.** Every computed snapshot is dropped. Nothing is
-- lost that cannot be recomputed: a snapshot is a function of the formula
-- version and the performance-event history (ADR-052 § 12), both of which
-- survive this rollback. What is lost is the record of *what was said when* —
-- the historical scores as they were computed at the time.
--
-- DROP TABLE fires none of the append-only or sealing triggers.

SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS "performance_score_source_event";
DROP TABLE IF EXISTS "performance_score_component";
DROP TABLE IF EXISTS "performance_score_snapshot";

DROP FUNCTION IF EXISTS "performance_score_snapshot_consistent"();
DROP FUNCTION IF EXISTS "performance_score_child_sealed"();
DROP FUNCTION IF EXISTS "performance_score_append_only"();

DROP INDEX IF EXISTS "ux_performance_event_tenant_source";
DROP INDEX IF EXISTS "ux_performance_formula_version_identity";

DROP TYPE IF EXISTS "PerformanceScoreStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926120000_performance_score_snapshot';
