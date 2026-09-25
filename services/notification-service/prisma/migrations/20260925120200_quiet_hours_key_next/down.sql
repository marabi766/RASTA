-- Reverses 20260925120200_quiet_hours_key_next.

DROP INDEX IF EXISTS "notification_quiet_hours_pkey_next";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120200_quiet_hours_key_next';
