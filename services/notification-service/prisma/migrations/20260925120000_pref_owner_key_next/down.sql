-- Reverses 20260925120000_pref_owner_key_next.

DROP INDEX IF EXISTS "ux_preference_owner_scope_channel_next";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260925120000_pref_owner_key_next';
