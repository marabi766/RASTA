-- D-156: what an order line agreed to, and the price history that proves it, never change.
--
-- order_line: the offer, its version, the unit price, the quantity, the line total and the
-- currency are fixed when the line is written. Its other columns keep their own rules (the
-- tenant FKs). offer_price_history: append-only, every column — a repricing is a new row at a new
-- version, never an edit of an old one.
--
-- Neither table's rows are ever removed (#1010 r1): a parent FK does not stop a child being
-- deleted on its own, and a deleted line could come back under the same id with another
-- quantity. So the row triggers fire BEFORE UPDATE OR DELETE, which also covers the cascades of
-- fk_order_line_tenant (an order deleted) and fk_offer_price_history_tenant (an offer deleted):
-- an order with a line, or an offer with a published price, can no longer be deleted. Nothing in
-- the service deletes either. A row that is never deleted cannot be re-inserted: the primary key
-- refuses a second row with its id, and ON CONFLICT DO UPDATE / MERGE reach the row guard.
-- TRUNCATE fires no row trigger, so each table also has a statement trigger. Any purge is the
-- owner's (the migrator role), lifting a guard for one transaction; the runtime role owns
-- nothing and cannot (D-045).
--
-- Names: a function body looks up no relation or function, and each operator it uses is
-- pg_catalog's by name, so no search_path can move one. Tables and functions stay unqualified:
-- CREATE binds them once, and the reversibility check applies this file in a scratch schema.
-- The path is not pinned: check:utc-clock-sites (#979) refuses a routine's SET search_path.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION "order_line_price_guard"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- All six columns are NOT NULL; a NULL would make the test NULL, and NULL refuses.
  IF TG_OP OPERATOR(pg_catalog.=) 'UPDATE'
     AND NEW."offer_id" OPERATOR(pg_catalog.=) OLD."offer_id"
     AND NEW."offer_version" OPERATOR(pg_catalog.=) OLD."offer_version"
     AND NEW."unit_price_minor" OPERATOR(pg_catalog.=) OLD."unit_price_minor"
     AND NEW."quantity" OPERATOR(pg_catalog.=) OLD."quantity"
     AND NEW."line_total_minor" OPERATOR(pg_catalog.=) OLD."line_total_minor"
     AND NEW."currency" OPERATOR(pg_catalog.=) OLD."currency" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_order_line_price_immutable: an order line keeps the offer version, price and quantity it was placed at (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "tg_order_line_price_guard"
  BEFORE UPDATE OR DELETE ON "order_line"
  FOR EACH ROW EXECUTE FUNCTION "order_line_price_guard"();

CREATE TRIGGER "tg_order_line_no_truncate"
  BEFORE TRUNCATE ON "order_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "order_line_price_guard"();

CREATE FUNCTION "offer_price_history_guard"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ck_offer_price_history_immutable: a published offer price is never changed or erased (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "tg_offer_price_history_guard"
  BEFORE UPDATE OR DELETE ON "offer_price_history"
  FOR EACH ROW EXECUTE FUNCTION "offer_price_history_guard"();

CREATE TRIGGER "tg_offer_price_history_no_truncate"
  BEFORE TRUNCATE ON "offer_price_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "offer_price_history_guard"();

COMMIT;
