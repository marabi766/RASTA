-- D-156: an order's financial snapshot is sealed when it is placed (#1010 r1, r2).
--
-- order_line: written once, by the transaction that places its order, and never changed or
-- removed. The service never updates a line, so every UPDATE is refused, every column: no
-- re-keying, no move to another order or tenant. Both tables carry placement_xact, which a
-- trigger stamps with the inserting transaction's id (pg_current_xact_id(): 64 bits, never
-- reused, the top-level id inside a savepoint too), whatever the writer sent.
-- fk_order_line_placement ties a line's (order_id, placement_xact) to its order's. A line that
-- a later transaction appends to a placed order carries that later id, and no order has it.
-- Lines and orders written before this migration keep a NULL stamp. The key does not check
-- them, and those lines cannot change either.
-- order: the columns that say who owes whom how much never change after INSERT: id,
-- organization_id, supplier_organization_id, total_amount_minor, currency and placement_xact.
-- No service UPDATE writes one.
-- offer_price_history: append-only, every column. A repricing is a new row at a new version.
--
-- Neither guarded table's rows are ever removed (#1010 r1). The row guards fire BEFORE UPDATE
-- OR DELETE, which also covers the cascades of fk_order_line_tenant (an order deleted) and
-- fk_offer_price_history_tenant (an offer deleted). A row that is never deleted cannot be
-- re-inserted under its id, and ON CONFLICT DO UPDATE / MERGE reach the row guard. TRUNCATE
-- fires no row trigger, so each table also has a statement trigger. Any purge is the owner's
-- (the migrator role), lifting a guard for one transaction; the runtime role owns nothing and
-- cannot (D-045). No race needs a lock: a stamp equals the current transaction's id only inside
-- the transaction that placed the order, and the key's check locks the order row it reads.
--
-- Names: each function pins search_path to pg_catalog, pg_temp. Its body looks up no relation,
-- and each operator and function it uses is pg_catalog's by name. Tables stay unqualified:
-- CREATE binds them once, and the reversibility check applies this file in a scratch schema.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "order" ADD COLUMN "placement_xact" xid8;
ALTER TABLE "order_line" ADD COLUMN "placement_xact" xid8;
CREATE UNIQUE INDEX "uq_order_placement" ON "order"("id", "placement_xact");
ALTER TABLE "order_line" ADD CONSTRAINT "fk_order_line_placement"
  FOREIGN KEY ("order_id", "placement_xact") REFERENCES "order"("id", "placement_xact")
  ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE FUNCTION "order_placement_stamp"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."placement_xact" := pg_catalog.pg_current_xact_id();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tg_order_placement_stamp"
  BEFORE INSERT ON "order"
  FOR EACH ROW EXECUTE FUNCTION "order_placement_stamp"();

CREATE TRIGGER "tg_order_line_placement_stamp"
  BEFORE INSERT ON "order_line"
  FOR EACH ROW EXECUTE FUNCTION "order_placement_stamp"();

CREATE FUNCTION "order_financial_guard"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Every column but placement_xact is NOT NULL; a NULL makes the test NULL, and NULL refuses.
  IF NEW."id" OPERATOR(pg_catalog.=) OLD."id"
     AND NEW."organization_id" OPERATOR(pg_catalog.=) OLD."organization_id"
     AND NEW."supplier_organization_id" OPERATOR(pg_catalog.=) OLD."supplier_organization_id"
     AND NEW."total_amount_minor" OPERATOR(pg_catalog.=) OLD."total_amount_minor"
     AND NEW."currency" OPERATOR(pg_catalog.=) OLD."currency"
     AND (NEW."placement_xact" OPERATOR(pg_catalog.=) OLD."placement_xact"
          OR (NEW."placement_xact" IS NULL AND OLD."placement_xact" IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_order_financial_immutable: an order keeps its parties, total and currency from placement (UPDATE refused)'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "tg_order_financial_guard"
  BEFORE UPDATE ON "order"
  FOR EACH ROW EXECUTE FUNCTION "order_financial_guard"();

CREATE FUNCTION "order_line_price_guard"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'ck_order_line_price_immutable: an order line is fixed when its order is placed (% refused)', TG_OP
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
  SET search_path = pg_catalog, pg_temp
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
