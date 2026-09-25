-- L7-44: drops the owner-resource index that did not lead with
-- organization_id, now that 20260925120000_document_org_owner_index has built
-- its replacement. CONCURRENTLY and alone in its file, for the same reason as
-- that build: no lock that blocks reads or writes while it waits.

DROP INDEX CONCURRENTLY IF EXISTS "ix_document_owner_resource";
