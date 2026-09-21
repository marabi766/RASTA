-- Reverse of `migration.sql`, in the order the dependencies allow.
--
-- **What a rollback costs, stated plainly.** Every email delivery is deleted
-- along with its attempts. A message already handed to a mail server has left
-- this platform and cannot be recalled by dropping a row: the rollback removes
-- the *record* that it was sent, not the mail. An operator rolling this back
-- accepts that the platform can no longer answer "was this person emailed".
-- Nobody is left uninformed by it — the in-app half of every one of those
-- notifications is untouched — but the evidence is gone.
--
-- Quiet windows are discarded, and everyone falls back to "no quiet window",
-- which is the behaviour of every recipient who never set one. Templates are
-- discarded too and re-seeded from the code catalogue the next time the
-- forward migration is applied, which is what "seeded configuration rather
-- than authored content" buys.
--
-- The enum value cannot be removed in place — PostgreSQL has no
-- `ALTER TYPE ... DROP VALUE` — so the type is rebuilt. Every column using it
-- is cast through text, which is why the EMAIL rows must be gone first.

DELETE FROM "delivery_attempt"
 WHERE "delivery_id" IN (SELECT "id" FROM "notification_delivery" WHERE "channel" = 'EMAIL');
DELETE FROM "notification_delivery" WHERE "channel" = 'EMAIL';
DELETE FROM "notification_preference" WHERE "channel" = 'EMAIL';

DROP INDEX IF EXISTS "ix_delivery_sendable";

ALTER TABLE "notification_delivery"
  DROP CONSTRAINT IF EXISTS "ck_delivery_rendered_hash_shape";

ALTER TABLE "notification_delivery"
  DROP COLUMN IF EXISTS "claim_token",
  DROP COLUMN IF EXISTS "claim_owner",
  DROP COLUMN IF EXISTS "claim_expires_at",
  DROP COLUMN IF EXISTS "rendered_hash";

DROP TABLE IF EXISTS "notification_quiet_hours";

DROP TRIGGER IF EXISTS "trg_template_version_immutable" ON "notification_template_version";
DROP TABLE IF EXISTS "notification_template_version";
DROP FUNCTION IF EXISTS notification_template_version_immutable();
DROP TABLE IF EXISTS "notification_template";

-- Rebuild `notification_channel` without EMAIL. The old type is renamed rather
-- than dropped first, because a column cannot be moved off a type that no
-- longer exists.
ALTER TYPE "notification_channel" RENAME TO "notification_channel_with_email";
CREATE TYPE "notification_channel" AS ENUM ('IN_APP');

ALTER TABLE "notification_delivery"
  ALTER COLUMN "channel" TYPE "notification_channel"
  USING "channel"::text::"notification_channel";

ALTER TABLE "notification_preference"
  ALTER COLUMN "channel" TYPE "notification_channel"
  USING "channel"::text::"notification_channel";

DROP TYPE "notification_channel_with_email";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260921090000_notification_email_channel';
