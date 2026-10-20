-- =============================================================================
-- Reverse of `migration.sql` (COM-007 PR 3).
--
-- Refuses, and changes nothing, while any setting version exists: each is the only record of what
-- an organization's windows were opened with and who decided it, and the windows that name one
-- would keep a version number nothing explains. With none, it drops the snapshot guard, the
-- foreign key, the table's guards and the table. Windows keep their snapshot columns, which PR 2
-- reads as before.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "aggregation_setting") THEN
    RAISE EXCEPTION 'refusing to reverse 20261020090000_aggregation_setting: aggregation_setting holds setting versions, refusing to drop the record of what was in force';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS "tg_demand_aggregation_snapshot" ON "demand_aggregation";
DROP FUNCTION IF EXISTS "demand_aggregation_snapshot_guard"();
ALTER TABLE "demand_aggregation" DROP CONSTRAINT IF EXISTS "fk_demand_aggregation_setting";

DROP TRIGGER IF EXISTS "tg_aggregation_setting_no_truncate" ON "aggregation_setting";
DROP TRIGGER IF EXISTS "tg_aggregation_setting_guard" ON "aggregation_setting";
DROP TABLE IF EXISTS "aggregation_setting";
DROP FUNCTION IF EXISTS "aggregation_setting_guard"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261020090000_aggregation_setting';
