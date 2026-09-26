-- Reverses 20260926100000_performance_formula_version.
--
-- **What a rollback costs.** Every formula version and its weights are
-- dropped with the tables. Nothing reads them yet — no snapshot exists before
-- step 4, and step 4's own down script runs first — so no computed score loses
-- its provenance, but the record of who configured which weights is gone from
-- this database. The audit events the outbox carried for each change remain in
-- audit-service.
--
-- DROP TABLE does not fire the no-delete or no-truncate triggers, which is why
-- this script can remove what the running service never may.

SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS "performance_formula_weight";
DROP TABLE IF EXISTS "performance_formula_version";

DROP FUNCTION IF EXISTS "performance_formula_successor_check"();
DROP FUNCTION IF EXISTS "performance_formula_weight_sum_check"();
DROP FUNCTION IF EXISTS "performance_formula_weight_guard"();
DROP FUNCTION IF EXISTS "performance_formula_version_guard"();

DROP TYPE IF EXISTS "PerformanceComponent";
DROP TYPE IF EXISTS "PerformanceFormulaStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926100000_performance_formula_version';
