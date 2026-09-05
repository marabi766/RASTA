-- =============================================================================
-- Reverse of `migration.sql`.
--
-- Drops what the forward migration created, in dependency order: children
-- before parents, then the enums, which cannot be dropped while a column still
-- uses them. Indexes and CHECK constraints go with their tables.
--
-- **This destroys the qualification and suspension record.** Reversing it
-- removes every approval, every rejection and every suspension episode this
-- service has stored, including who decided them and when — the records an
-- audit exists to read. It does not touch document-service, so the documents
-- that were referenced as evidence survive with nothing left that knows which
-- submission cited them.
--
-- That is not a reason to omit the script: a migration must be reversible
-- (AGENTS.md § 7). It is a reason to say so here rather than let somebody find
-- out afterwards. Anything published from the outbox has already left; dropping
-- the table cannot recall it, and consumers that acted on a SUPPLIER_QUALIFIED
-- will still believe the supplier is qualified.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TABLE IF EXISTS "processed_event";
DROP TABLE IF EXISTS "outbox_stream_sequence";
DROP TABLE IF EXISTS "outbox_message";

DROP TABLE IF EXISTS "qualification_evidence";
DROP TABLE IF EXISTS "qualification";
DROP TABLE IF EXISTS "suspension";
DROP TABLE IF EXISTS "supplier_capability";
DROP TABLE IF EXISTS "supplier";

DROP TYPE IF EXISTS "QualificationState";
DROP TYPE IF EXISTS "SupplierStatus";
DROP TYPE IF EXISTS "SupplierCapabilityKind";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260905120000_init_supplier';
