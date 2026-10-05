-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created: the guard triggers and their function,
-- then the tables, then the enum (which cannot be dropped while a column uses it).
-- Indexes and CHECK constraints go with their tables.
--
-- **This destroys every contract this service has stored**, including the award
-- each was made from. Anything already published from the outbox has left:
-- dropping the table cannot recall it, and audit-service keeps its own copy of
-- every event it received. `construction-service` still holds the award itself, so
-- a replayed `TENDER_AWARDED` rebuilds the drafts (ADR-068 § 3).
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_contract_no_truncate" ON "contract";
DROP TRIGGER IF EXISTS "tg_contract_guard" ON "contract";
DROP FUNCTION IF EXISTS "contract_guard"();

DROP TABLE IF EXISTS "outbox_stream_sequence";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "contract";

DROP TYPE IF EXISTS "ContractStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005100000_init_contract';
