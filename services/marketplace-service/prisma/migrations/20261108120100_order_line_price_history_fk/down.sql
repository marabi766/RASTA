-- Reverses 20261108120100_order_line_price_history_fk. Removes a check, never a row.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "order_line" DROP CONSTRAINT "fk_order_line_price_history";
DROP INDEX "uq_offer_price_history_price";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108120100_order_line_price_history_fk';
COMMIT;
