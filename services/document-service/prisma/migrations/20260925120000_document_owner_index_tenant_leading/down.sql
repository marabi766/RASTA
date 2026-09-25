-- Reverses 20260925120000_document_owner_index_tenant_leading.

DROP INDEX "ix_document_org_owner_resource";

CREATE INDEX "ix_document_owner_resource" ON "document"("owner_resource_type", "owner_resource_id");

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120000_document_owner_index_tenant_leading';
