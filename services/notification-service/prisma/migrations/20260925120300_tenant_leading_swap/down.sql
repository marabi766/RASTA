-- Reverses 20260925120300_tenant_leading_swap: the user-leading keys and the
-- two helper indexes come back under their original names and definitions,
-- and the organization-leading ones go back to their `_next` names, which is
-- the state the three CONCURRENTLY migrations before this one left.
--
-- Same shape as the forward swap: build first, then swap in one transaction.
-- This script is one transaction too (it must also delete its own ledger row,
-- and CONCURRENTLY cannot share a script), so the builds below take a lock
-- that blocks writes to each table for as long as the build runs. Both tables
-- hold one row per person per setting. To take no such lock on a large table,
-- run these statements first, one at a time — the IF NOT EXISTS below then
-- finds them built and this script only swaps:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_quiet_hours_org" ON "notification_quiet_hours" ("organization_id");
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "notification_quiet_hours_pkey_prev" ON "notification_quiet_hours" ("user_id", "organization_id");
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "notification_quiet_hours_pkey_next" ON "notification_quiet_hours" ("organization_id", "user_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_preference_owner" ON "notification_preference" ("organization_id", "user_id");
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ux_preference_global_channel_prev" ON "notification_preference" ("user_id", "organization_id", "channel") WHERE "scope" = 'GLOBAL';
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ux_preference_owner_scope_channel_prev" ON "notification_preference" ("user_id", "organization_id", "scope", "scope_key", "channel");
SET LOCAL lock_timeout = '5s';

-- notification_quiet_hours --------------------------------------------------

CREATE INDEX IF NOT EXISTS "ix_quiet_hours_org" ON "notification_quiet_hours" ("organization_id");

CREATE UNIQUE INDEX IF NOT EXISTS "notification_quiet_hours_pkey_prev"
    ON "notification_quiet_hours" ("user_id", "organization_id");
-- Dropping the organization-leading primary key drops its index, and the
-- state before the forward swap still holds it as `_next`.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_quiet_hours_pkey_next"
    ON "notification_quiet_hours" ("organization_id", "user_id");
ALTER TABLE "notification_quiet_hours" DROP CONSTRAINT "notification_quiet_hours_pkey";
ALTER TABLE "notification_quiet_hours"
  ADD CONSTRAINT "notification_quiet_hours_pkey" PRIMARY KEY USING INDEX "notification_quiet_hours_pkey_prev";

-- notification_preference ---------------------------------------------------

CREATE INDEX IF NOT EXISTS "ix_preference_owner"
    ON "notification_preference" ("organization_id", "user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "ux_preference_global_channel_prev"
    ON "notification_preference" ("user_id", "organization_id", "channel")
 WHERE "scope" = 'GLOBAL';
ALTER INDEX "ux_preference_global_channel" RENAME TO "ux_preference_global_channel_next";
ALTER INDEX "ux_preference_global_channel_prev" RENAME TO "ux_preference_global_channel";

CREATE UNIQUE INDEX IF NOT EXISTS "ux_preference_owner_scope_channel_prev"
    ON "notification_preference" ("user_id", "organization_id", "scope", "scope_key", "channel");
ALTER INDEX "ux_preference_owner_scope_channel" RENAME TO "ux_preference_owner_scope_channel_next";
ALTER INDEX "ux_preference_owner_scope_channel_prev" RENAME TO "ux_preference_owner_scope_channel";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120300_tenant_leading_swap';
