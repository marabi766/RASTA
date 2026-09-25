-- Reverses 20260925120100_pref_global_key_next.

DROP INDEX IF EXISTS "ux_preference_global_channel_next";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120100_pref_global_key_next';
