-- Supplier pattern: migration-owned explicit per-table grants, no blanket DML.
-- The only runtime writes are MaintenanceFactRepository.record(): INSERT the
-- processed_event marker and INSERT the fact, both ON CONFLICT DO NOTHING.
-- SELECT supports duplicate comparison, dashboard/KPI reads and returning rows.
SET LOCAL lock_timeout = '5s';

-- Also upgrades a database previously provisioned in default mode. Removing
-- existing grants alone would leave every future table writable via pg_default_acl.
REVOKE ALL ON "fact_maintenance", "processed_event", "baseline_metric" FROM rasta_analytics;
DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM rasta_analytics', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM rasta_analytics', current_schema());
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM rasta_analytics', current_schema());
END;
$$;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM rasta_analytics;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM rasta_analytics;

GRANT SELECT, INSERT ON "fact_maintenance", "processed_event" TO rasta_analytics;
GRANT SELECT ON "baseline_metric" TO rasta_analytics;
