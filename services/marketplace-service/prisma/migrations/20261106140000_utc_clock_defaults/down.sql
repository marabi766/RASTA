-- Restores the session-dependent defaults of 20261106140000_utc_clock_defaults.
SET LOCAL lock_timeout = '3s';
ALTER TABLE "order" ALTER COLUMN "saga_start_next_attempt_at" SET DEFAULT CURRENT_TIMESTAMP;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106140000_utc_clock_defaults';
