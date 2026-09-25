-- Reverse of `migration.sql`: restores the default the initial migration gave
-- `assignment.started_at` (`DEFAULT CURRENT_TIMESTAMP`, init_fleet line 37).
--
-- This brings back the second clock that migration removed — reversing it
-- means exactly that. Every production path sets `started_at` explicitly, so
-- the default only matters to a write that omits it.
--
-- The `_prisma_migrations` row is removed so the forward migration can be
-- re-applied.

ALTER TABLE "assignment" ALTER COLUMN "started_at" SET DEFAULT CURRENT_TIMESTAMP;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260828051500_assignment_started_at_no_default';
