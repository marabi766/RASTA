-- Reverses 20260925120000_tenant_leading_indexes: restores the user-leading
-- keys and the two helper indexes, under their original names and definitions.

CREATE INDEX "ix_quiet_hours_org" ON "notification_quiet_hours" ("organization_id");

ALTER TABLE "notification_quiet_hours" DROP CONSTRAINT "notification_quiet_hours_pkey";
ALTER TABLE "notification_quiet_hours"
  ADD CONSTRAINT "notification_quiet_hours_pkey" PRIMARY KEY ("user_id", "organization_id");

CREATE INDEX "ix_preference_owner"
    ON "notification_preference" ("organization_id", "user_id");

DROP INDEX "ux_preference_global_channel";
CREATE UNIQUE INDEX "ux_preference_global_channel"
    ON "notification_preference" ("user_id", "organization_id", "channel")
 WHERE "scope" = 'GLOBAL';

DROP INDEX "ux_preference_owner_scope_channel";
CREATE UNIQUE INDEX "ux_preference_owner_scope_channel"
    ON "notification_preference" ("user_id", "organization_id", "scope", "scope_key", "channel");

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120000_tenant_leading_indexes';
