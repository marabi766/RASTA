-- Reverses 20261024120000_user_keycloak_reassert_at. A pending mark is lost:
-- run `keycloak:backfill` afterwards, which re-projects every account.
ALTER TABLE "user" DROP COLUMN IF EXISTS "keycloak_reassert_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024120000_user_keycloak_reassert_at';
