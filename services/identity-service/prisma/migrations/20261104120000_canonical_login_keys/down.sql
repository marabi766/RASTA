-- Reverses 20261104120000_canonical_login_keys. Safe at any time: it only stops refusing; the byte
-- indexes `user_username_key` and `user_email_key` remain.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ux_user_email_login_key";
DROP INDEX IF EXISTS "ux_user_username_login_key";
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "ck_user_login_printable_ascii";
DROP FUNCTION IF EXISTS "user_login_key"(TEXT);

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104120000_canonical_login_keys';
