-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: the child
-- table before its parent, then the enums, which cannot be dropped while a
-- column still uses them.
--
-- **This destroys document metadata.** It does not touch object storage, so
-- reversing it leaves every uploaded object in the bucket with nothing left
-- that knows which organization owns it, what it is, or whether it was ever
-- scanned. That is not a reason to avoid the script — a schema must be
-- reversible (AGENTS.md § 7) — but it is a reason to say so here rather than
-- let somebody discover it afterwards. Orphaned objects are the known cost
-- ADR-014 already names for the direct-upload pattern; this widens it.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "access_grant";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "document";
DROP TABLE IF EXISTS "upload_intent";

DROP TYPE IF EXISTS "UploadIntentState";
DROP TYPE IF EXISTS "ScanState";
DROP TYPE IF EXISTS "DocumentStatus";
DROP TYPE IF EXISTS "DocumentClass";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260830215511_init_document';
