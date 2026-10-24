-- Fail closed: remove this migration's fact/marker grants. Baseline SELECT
-- belongs to 120000 and remains until that migration is rolled back.
-- Never restore the unsafe legacy defaults. Reapply up before serving traffic.
SET LOCAL lock_timeout = '5s';
REVOKE ALL ON "fact_maintenance", "processed_event" FROM rasta_analytics;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024130000_analytics_runtime_privileges';
