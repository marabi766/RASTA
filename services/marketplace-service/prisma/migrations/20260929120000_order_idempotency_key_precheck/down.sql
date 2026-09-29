-- Reverses 20260929120000_order_idempotency_key_precheck, which created nothing:
-- only its record goes, so it runs again on the next deploy.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260929120000_order_idempotency_key_precheck';
