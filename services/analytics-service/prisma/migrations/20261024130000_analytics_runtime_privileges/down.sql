-- Fail closed, as supplier's rollback does: runtime loses its explicit grants.
-- Never restore the unsafe legacy defaults. Reapply up before serving traffic.
SET LOCAL lock_timeout = '5s';
REVOKE ALL ON "fact_maintenance", "processed_event", "baseline_metric" FROM rasta_analytics;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024130000_analytics_runtime_privileges';
