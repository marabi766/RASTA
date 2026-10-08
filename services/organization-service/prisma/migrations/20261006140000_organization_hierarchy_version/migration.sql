-- =============================================================================
-- organization-service — a hierarchy version on every organization (CON-003 PR 2 review round 4,
-- ruling 1; docs/23 D-050).
--
-- A timestamp cannot order a move against a read in another service: ORGANIZATION_MOVED carries
-- the instant the move was prepared, a read can land after that instant and still before the move
-- commits, and it then sees the old tree with a "later" time. A version can: `hierarchy_version`
-- is bumped in the SAME transaction as any move that changes an organization's ancestry — the
-- moved organization and every descendant, all set to one value, strictly above every version
-- there was (`max + 1`, computed under the hierarchy lock that serialises moves) — so what a read
-- returns is either the tree before that move (a lower version) or after it (that version or
-- higher), never a time to be compared with a clock.
--
-- Every row starts at 1: no ancestry has changed since it was created. `organization` is the
-- hierarchy itself, not tenant data, so there is no tenant to lead the index with; the index
-- backs `max(hierarchy_version)` under the lock.
-- =============================================================================

SET LOCAL lock_timeout = '3s';

ALTER TABLE "organization" ADD COLUMN "hierarchy_version" BIGINT NOT NULL DEFAULT 1;
ALTER TABLE "organization" ADD CONSTRAINT "ck_organization_hierarchy_version_positive"
  CHECK ("hierarchy_version" >= 1);

CREATE INDEX "organization_hierarchy_version_idx" ON "organization" ("hierarchy_version");
