-- Reverses 20261004100300_user_account_activation_pending. An approval still
-- waiting for its activation then stays disabled until someone enables the
-- account by hand: run `keycloak:reconcile` first and clear what it reports.
ALTER TABLE "user" DROP COLUMN IF EXISTS "account_activation_pending";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004100300_user_account_activation_pending';
