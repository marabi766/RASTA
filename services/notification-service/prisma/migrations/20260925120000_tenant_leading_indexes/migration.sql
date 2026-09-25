-- L7-44 / ADR-011: every composite index on a tenant table leads with
-- organization_id.
--
-- Three keys here led with user_id instead:
--
--   ux_preference_owner_scope_channel   (user_id, organization_id, scope, scope_key, channel)
--   ux_preference_global_channel        (user_id, organization_id, channel) WHERE scope = 'GLOBAL'
--   notification_quiet_hours_pkey       (user_id, organization_id)
--
-- Every read of either table is tenant-scoped by the guard and names the user
-- as well: `organization_id = $1 AND user_id = $2`, or `user_id IN (...)` for
-- a dispatch. So each table also carried a separate index to serve that shape
-- (`ix_preference_owner`, `ix_quiet_hours_org`).
--
-- Reordering the keys changes nothing about what they refuse: the column sets
-- are the same, so the same rows collide. With organization_id first, the
-- unique key and the primary key serve the tenant reads themselves, and the
-- two helper indexes become exact prefixes of them. They are dropped.
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma Migrate runs each migration in
-- a transaction, and both tables hold one row per person per setting.

-- notification_preference ---------------------------------------------------

DROP INDEX "ux_preference_owner_scope_channel";
CREATE UNIQUE INDEX "ux_preference_owner_scope_channel"
    ON "notification_preference" ("organization_id", "user_id", "scope", "scope_key", "channel");

-- The GLOBAL half of the same rule, because NULL is distinct in a unique index.
DROP INDEX "ux_preference_global_channel";
CREATE UNIQUE INDEX "ux_preference_global_channel"
    ON "notification_preference" ("organization_id", "user_id", "channel")
 WHERE "scope" = 'GLOBAL';

-- A prefix of ux_preference_owner_scope_channel now.
DROP INDEX "ix_preference_owner";

-- notification_quiet_hours --------------------------------------------------

ALTER TABLE "notification_quiet_hours" DROP CONSTRAINT "notification_quiet_hours_pkey";
ALTER TABLE "notification_quiet_hours"
  ADD CONSTRAINT "notification_quiet_hours_pkey" PRIMARY KEY ("organization_id", "user_id");

-- A prefix of the primary key now.
DROP INDEX "ix_quiet_hours_org";
