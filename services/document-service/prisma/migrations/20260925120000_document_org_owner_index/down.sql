-- Reverses 20260925120000_document_org_owner_index. Dropping an index is a
-- catalogue change, so its exclusive lock is held for milliseconds.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS "ix_document_org_owner_resource";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120000_document_org_owner_index';
