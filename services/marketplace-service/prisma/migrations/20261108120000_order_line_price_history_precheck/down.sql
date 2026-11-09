-- Reverses 20261108120000_order_line_price_history_precheck, which created nothing:
-- only its record goes, so it runs again on the next deploy.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108120000_order_line_price_history_precheck';
