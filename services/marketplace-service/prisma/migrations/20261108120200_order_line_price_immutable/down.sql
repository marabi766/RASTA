-- Reverses 20261108120200_order_line_price_immutable. Removes the guards, never a row.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP TRIGGER "tg_offer_price_history_no_truncate" ON "offer_price_history";
DROP TRIGGER "tg_offer_price_history_guard" ON "offer_price_history";
DROP FUNCTION "offer_price_history_guard"();
DROP TRIGGER "tg_order_line_no_truncate" ON "order_line";
DROP TRIGGER "tg_order_line_price_guard" ON "order_line";
DROP FUNCTION "order_line_price_guard"();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108120200_order_line_price_immutable';
COMMIT;
