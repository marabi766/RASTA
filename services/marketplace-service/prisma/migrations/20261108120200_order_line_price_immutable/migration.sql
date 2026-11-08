-- D-156: what an order line agreed to, and the price history that proves it, never change.
--
-- order_line: the offer, its version, the unit price, the quantity, the line total and the
-- currency are fixed when the line is written. Its other columns keep their own rules (the
-- tenant FKs). offer_price_history: append-only, every column — a repricing is a new row at a new
-- version, never an edit of an old one. Neither table may be TRUNCATEd (a statement trigger:
-- TRUNCATE fires no row trigger). A DELETE is not refused here: a history row a line names is
-- held by fk_order_line_price_history (ON DELETE RESTRICT), and a line goes only with its order.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION "order_line_price_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."offer_id", NEW."offer_version", NEW."unit_price_minor", NEW."quantity",
          NEW."line_total_minor", NEW."currency")
         IS NOT DISTINCT FROM
         (OLD."offer_id", OLD."offer_version", OLD."unit_price_minor", OLD."quantity",
          OLD."line_total_minor", OLD."currency") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_order_line_price_immutable: an order line keeps the offer version, price and quantity it was placed at (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_order_line_price_guard"
  BEFORE UPDATE ON "order_line"
  FOR EACH ROW EXECUTE FUNCTION "order_line_price_guard"();

CREATE TRIGGER "tg_order_line_no_truncate"
  BEFORE TRUNCATE ON "order_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "order_line_price_guard"();

CREATE FUNCTION "offer_price_history_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_offer_price_history_immutable: a published offer price is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_offer_price_history_guard"
  BEFORE UPDATE ON "offer_price_history"
  FOR EACH ROW EXECUTE FUNCTION "offer_price_history_guard"();

CREATE TRIGGER "tg_offer_price_history_no_truncate"
  BEFORE TRUNCATE ON "offer_price_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "offer_price_history_guard"();

COMMIT;
