-- L7-44 / ADR-011: every composite index on a tenant table leads with
-- organization_id.
--
-- ix_document_owner_resource was (owner_resource_type, owner_resource_id). Its
-- only reader is the tenant-scoped document list
-- (DocumentRepository.list, `?ownerResourceType=&ownerResourceId=`), which the
-- tenant guard always narrows with `organization_id = $1`. No runUnscoped path
-- filters by owner resource. The replacement leads with organization_id and
-- keeps the owner pair after it, so the list is answered inside one tenant's
-- slice of the index.
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma Migrate runs each migration in
-- a transaction (see 20260902130000_outbox_claim_stream_indexes).

DROP INDEX "ix_document_owner_resource";

CREATE INDEX "ix_document_org_owner_resource"
    ON "document" ("organization_id", "owner_resource_type", "owner_resource_id");
