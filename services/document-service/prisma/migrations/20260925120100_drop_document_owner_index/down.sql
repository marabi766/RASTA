-- Reverses 20260925120100_drop_document_owner_index.
--
-- This script is one transaction (it must also delete its own ledger row, and
-- CONCURRENTLY cannot share a script), so the build below blocks writes to
-- `document` while it runs. To take no such lock, run this first on its own —
-- the IF NOT EXISTS below then finds the index built:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_document_owner_resource" ON "document" ("owner_resource_type", "owner_resource_id");
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "ix_document_owner_resource" ON "document"("owner_resource_type", "owner_resource_id");

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120100_drop_document_owner_index';
