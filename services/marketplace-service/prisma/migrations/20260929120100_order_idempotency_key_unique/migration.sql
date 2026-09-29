-- Review of #141: an Idempotency-Key places at most one order per organization.
--
-- The idempotency record is the first guard: a retry replays the stored
-- response. It is not the only one any more. A record that is lost — released
-- after the order committed, purged after it expired — used to leave the key
-- free, and the next request with it placed a second order. This index makes
-- that insert fail; OrderService.place answers it as 409 CONFLICT.
--
-- A full index rather than `WHERE idempotency_key IS NOT NULL`: the column is
-- NOT NULL (init migration), so that predicate would cover every row and add
-- nothing, and a full index is one schema.prisma can declare (@@unique).
-- Leads with organization_id, like every index on a tenant table (ADR-011).
--
-- Built CONCURRENTLY, so orders can still be placed during the build. One
-- statement, on purpose: CONCURRENTLY cannot run inside a transaction block,
-- and PostgreSQL runs a multi-statement script as one implicit transaction.
-- The previous migration refuses to let this run over duplicates. A build that
-- fails anyway leaves an INVALID index: DROP INDEX it and deploy again. No
-- IF NOT EXISTS, so such a leftover fails the deploy instead of being taken
-- for the real index.

CREATE UNIQUE INDEX CONCURRENTLY "uq_order_org_idempotency_key"
    ON "order" ("organization_id", "idempotency_key");
