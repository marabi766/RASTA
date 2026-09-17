-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: children
-- before parents, the trigger function after the trigger that calls it, then
-- the enums, which cannot be dropped while a column still uses them. Indexes
-- and CHECK constraints go with their tables.
--
-- **This destroys the delivery record.** Reversing it removes every intent,
-- every recipient snapshot, every delivery outcome and every in-app
-- notification this service has stored — the answer to "who was told, and
-- when" is gone with it. It also removes `processed_event` and
-- `notification_dedupe`, so a subsequent `up` followed by a replay of the
-- source topics will notify **again** for anything still inside its semantic
-- window; ADR-054 § 8 names replay a deliberate operational act for exactly
-- this reason.
--
-- That is not a reason to omit the script: a migration must be reversible
-- (AGENTS.md § 7). It is a reason to say so here rather than let somebody find
-- out afterwards.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "delivery_attempt_append_only" ON "delivery_attempt";
DROP FUNCTION IF EXISTS refuse_attempt_update();

DROP TABLE IF EXISTS "in_app_notification";
DROP TABLE IF EXISTS "delivery_attempt";
DROP TABLE IF EXISTS "notification_delivery";
DROP TABLE IF EXISTS "recipient_resolution";
DROP TABLE IF EXISTS "notification_dedupe";
DROP TABLE IF EXISTS "notification_intent";
DROP TABLE IF EXISTS "processed_event";

DROP TYPE IF EXISTS "attempt_outcome";
DROP TYPE IF EXISTS "delivery_status";
DROP TYPE IF EXISTS "notification_channel";
DROP TYPE IF EXISTS "resolution_source";
DROP TYPE IF EXISTS "intent_status";
DROP TYPE IF EXISTS "notification_classification";
DROP TYPE IF EXISTS "notification_severity";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260917090000_init_notification';
