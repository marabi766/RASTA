-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 4a).
--
-- Drops the freeze trigger and its function, both tables (indexes, CHECKs and the
-- tenant-bound foreign key go with them) and the enum, which cannot be dropped
-- while a column uses it.
--
-- **This destroys every criteria template and every tender's criteria this
-- service has stored.** Events already published from the outbox have left;
-- audit-service keeps its own copy of what it received.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_tender_criterion_freeze" ON "tender_criterion";
DROP FUNCTION IF EXISTS "tender_criterion_freeze"();

DROP TRIGGER IF EXISTS "tg_tender_publish_requires_criteria" ON "tender";
DROP FUNCTION IF EXISTS "tender_publish_requires_criteria"();

DROP TRIGGER IF EXISTS "tg_tender_status_transition" ON "tender";
DROP FUNCTION IF EXISTS "tender_status_transition_guard"();

DROP TRIGGER IF EXISTS "tg_criteria_template_append_only" ON "criteria_template";
DROP TRIGGER IF EXISTS "tg_criteria_template_no_truncate" ON "criteria_template";
DROP FUNCTION IF EXISTS "criteria_template_append_only"();

DROP TABLE IF EXISTS "tender_criterion";
DROP TABLE IF EXISTS "criteria_template";

DROP TYPE IF EXISTS "ScoringMethod";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930170000_tender_criteria';
