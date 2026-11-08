-- Restores the session-dependent defaults of 20261106140000_utc_clock_defaults.
SET LOCAL lock_timeout = '3s';
ALTER TABLE "registration_intake" ALTER COLUMN "received_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "registration_intake" ALTER COLUMN "next_attempt_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "user_provisioning_intent" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106140000_utc_clock_defaults';
