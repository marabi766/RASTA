-- One live membership per (user, organization), enforced by the database.
--
-- Partial on deleted_at IS NULL, so a revoked membership (deleted_at set) does
-- not block the person being added again later — what the Prisma schema always
-- said `unique_active_membership` did, and the old index never did. A second
-- concurrent addMembership now fails on this index, and createMembershipRow
-- answers it exactly as it answers an existing membership: 409 ALREADY_EXISTS.
--
-- Built CONCURRENTLY, so membership writes continue during the build. One
-- statement, alone in its file: CONCURRENTLY cannot run inside a transaction
-- block, and PostgreSQL runs a multi-statement script as one implicit
-- transaction. The previous migration refused if duplicates existed; one
-- written between that check and this build makes the build fail and leaves
-- an INVALID index — DROP INDEX it, resolve the duplicate as that migration's
-- HINT says, and deploy again.
--
-- Tenant column first (docs/05, L7-44): uniqueness does not depend on column
-- order, and findMembership names both columns, so organization_id leading
-- costs no reader and needs no exemption from the tenant index order check.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ux_membership_live_user_org"
    ON "membership" ("organization_id", "user_id")
 WHERE "deleted_at" IS NULL;
