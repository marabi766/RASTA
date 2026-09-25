-- L7-44 / ADR-011: every composite index on a tenant table leads with
-- organization_id.
--
-- ix_document_owner_resource is (owner_resource_type, owner_resource_id). Its
-- only reader is the tenant-scoped document list
-- (DocumentRepository.list, `?ownerResourceType=&ownerResourceId=`), which the
-- tenant guard always narrows with `organization_id = $1`. No runUnscoped path
-- filters by owner resource. The replacement leads with organization_id and
-- keeps the owner pair after it, so the list is answered inside one tenant's
-- slice of the index. The next migration drops the old one.
--
-- Built first and CONCURRENTLY, so writes to `document` continue during the
-- build and the list is never without an index. One statement, on purpose:
-- CONCURRENTLY cannot run inside a transaction block, and PostgreSQL runs a
-- multi-statement script as one implicit transaction. A failed build leaves an
-- INVALID index; DROP INDEX it and deploy again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_document_org_owner_resource"
    ON "document" ("organization_id", "owner_resource_type", "owner_resource_id");
