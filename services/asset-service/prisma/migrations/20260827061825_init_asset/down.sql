-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: children
-- before parents, then the enums, which cannot be dropped while a column still
-- uses them. Indexes, CHECK constraints and foreign keys go with their tables.
-- No CASCADE: if a later migration's object still depends on one of these, its
-- own down.sql did not run, and this should fail rather than take it silently.
--
-- **This destroys every asset record** — the electronic file, its transfer,
-- location, insurance, inspection and timeline history. Anything already
-- published from the outbox has left; dropping the table cannot recall it.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "idempotency_key";
DROP TABLE IF EXISTS "outbox_message";
DROP TABLE IF EXISTS "organization_ref";

DROP TABLE IF EXISTS "asset_timeline_entry";
DROP TABLE IF EXISTS "technical_inspection";
DROP TABLE IF EXISTS "insurance_claim";
DROP TABLE IF EXISTS "insurance_policy";
DROP TABLE IF EXISTS "asset_document_ref";
DROP TABLE IF EXISTS "asset_location";
DROP TABLE IF EXISTS "asset_transfer";
DROP TABLE IF EXISTS "asset";

DROP TYPE IF EXISTS "TimelineCategory";
DROP TYPE IF EXISTS "InspectionResult";
DROP TYPE IF EXISTS "ClaimStatus";
DROP TYPE IF EXISTS "PolicyStatus";
DROP TYPE IF EXISTS "InsuranceCoverage";
DROP TYPE IF EXISTS "AssetDocumentKind";
DROP TYPE IF EXISTS "LocationSource";
DROP TYPE IF EXISTS "OperationalStatus";
DROP TYPE IF EXISTS "AssetType";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260827061825_init_asset';
