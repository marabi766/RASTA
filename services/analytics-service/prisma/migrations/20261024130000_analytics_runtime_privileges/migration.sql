-- Refuse a misconfigured runner before changing any privileges. Never echo its identity.
DO $$
BEGIN
  IF current_user <> 'rasta_analytics_migrator' THEN
    RAISE EXCEPTION 'analytics privilege migration requires the migrator role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Supplier pattern: migration-owned explicit per-table grants, no blanket DML.
-- The only runtime writes are MaintenanceFactRepository.record(): INSERT the
-- processed_event marker and INSERT the fact, both ON CONFLICT DO NOTHING.
-- SELECT supports duplicate comparison, dashboard/KPI reads and returning rows.
SET LOCAL lock_timeout = '5s';

REVOKE ALL ON "fact_maintenance", "processed_event", "baseline_metric" FROM rasta_analytics;
-- Exact entries written by service-privilege-split.bash's OLD default mode.
ALTER DEFAULT PRIVILEGES FOR ROLE rasta_analytics_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM rasta_analytics;
ALTER DEFAULT PRIVILEGES FOR ROLE rasta_analytics_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM rasta_analytics;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rasta_analytics;

GRANT SELECT, INSERT ON "fact_maintenance", "processed_event" TO rasta_analytics;
GRANT SELECT ON "baseline_metric" TO rasta_analytics;
