-- Reverses 20261108120200_order_line_price_immutable. Removes the guards and the placement
-- stamps, never a row.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP TRIGGER "tg_offer_price_history_no_truncate" ON "offer_price_history";
DROP TRIGGER "tg_offer_price_history_guard" ON "offer_price_history";
DROP FUNCTION "offer_price_history_guard"();
DROP TRIGGER "tg_order_line_no_truncate" ON "order_line";
DROP TRIGGER "tg_order_line_price_guard" ON "order_line";
DROP FUNCTION "order_line_price_guard"();
DROP TRIGGER "tg_order_financial_guard" ON "order";
DROP FUNCTION "order_financial_guard"();
DROP TRIGGER "tg_order_line_placement_stamp" ON "order_line";
DROP TRIGGER "tg_order_placement_stamp" ON "order";
DROP FUNCTION "order_placement_stamp"();
ALTER TABLE "order_line" DROP CONSTRAINT "fk_order_line_placement";
DROP INDEX "uq_order_placement";
ALTER TABLE "order_line" DROP COLUMN "placement_xact";
ALTER TABLE "order" DROP COLUMN "placement_xact";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108120200_order_line_price_immutable';
COMMIT;
