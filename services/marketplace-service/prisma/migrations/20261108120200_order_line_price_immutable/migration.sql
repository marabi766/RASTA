-- D-156: an order's financial snapshot is sealed when it is placed (#1010 r1-r4).
--
-- order_line: written once, by the transaction that places its order, and never changed or
-- removed. The service never updates a line, so every UPDATE is refused, every column: no
-- re-keying, no move to another order or tenant.
-- order.lines_sealed (r4) is the persisted fact "placed, lines closed": data, so a dump and
-- restore keeps it, whatever the new cluster's transaction counter does. A deferred constraint
-- trigger sets it at the end of the transaction that inserts the order, and the header guard
-- never lets it go back. A line INSERT reads its order FOR SHARE and is refused once the order
-- is sealed, or when there is none: a seal in flight (an UPDATE of the order) and an append wait
-- for each other, so the append reads the seal. Every order before this migration is placed:
-- ADD COLUMN ... DEFAULT true seals each, then new orders start open.
-- order: the columns that say who owes whom how much never change after INSERT: id,
-- organization_id, supplier_organization_id, total_amount_minor and currency. No service
-- UPDATE writes one.
-- offer_price_history: append-only, every column. A repricing is a new row at a new version.
--
-- Neither guarded table's rows are ever removed (#1010 r1). The row guards fire BEFORE UPDATE
-- OR DELETE, which also covers the cascades of fk_order_line_tenant (an order deleted) and
-- fk_offer_price_history_tenant (an offer deleted). A row that is never deleted cannot be
-- re-inserted under its id, and ON CONFLICT DO UPDATE / MERGE reach the row guard. TRUNCATE
-- fires no row trigger, so each table also has a statement trigger. Any purge is the owner's
-- (the migrator role), lifting a guard for one transaction; the runtime role owns nothing and
-- cannot (D-045).
--
-- Names: a function that reads no relation pins search_path to pg_catalog, pg_temp, and each
-- operator and function it uses is pg_catalog's by name. The two that read "order" resolve it
-- by the caller's path (the reversibility check applies this file in a scratch schema) and
-- name each operator by schema; the runtime role has no TEMPORARY to shadow it (D-045).
-- Tables stay unqualified: CREATE binds them once.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "order" ADD COLUMN "lines_sealed" boolean NOT NULL DEFAULT true;
ALTER TABLE "order" ALTER COLUMN "lines_sealed" SET DEFAULT false;

CREATE FUNCTION "order_lines_seal"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- No row: the order was deleted in its own transaction, and no line can name it.
  UPDATE "order" SET "lines_sealed" = true
   WHERE "organization_id" OPERATOR(pg_catalog.=) NEW."organization_id"
     AND "id" OPERATOR(pg_catalog.=) NEW."id";
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "tg_order_lines_seal"
  AFTER INSERT ON "order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "order_lines_seal"();

CREATE FUNCTION "order_line_admission"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  sealed boolean;
BEGIN
  SELECT o."lines_sealed" INTO sealed FROM "order" AS o
   WHERE o."organization_id" OPERATOR(pg_catalog.=) NEW."organization_id"
     AND o."id" OPERATOR(pg_catalog.=) NEW."order_id"
     FOR SHARE;
  IF sealed IS NOT FALSE THEN
    RAISE EXCEPTION 'ck_order_lines_sealed: an order line is written only by the transaction placing its order (INSERT refused)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tg_order_line_admission"
  BEFORE INSERT ON "order_line"
  FOR EACH ROW EXECUTE FUNCTION "order_line_admission"();

CREATE FUNCTION "order_financial_guard"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Every column is NOT NULL; a NULL makes the test NULL, and NULL refuses. A seal stays.
  IF NEW."id" OPERATOR(pg_catalog.=) OLD."id"
     AND NEW."organization_id" OPERATOR(pg_catalog.=) OLD."organization_id"
     AND NEW."supplier_organization_id" OPERATOR(pg_catalog.=) OLD."supplier_organization_id"
     AND NEW."total_amount_minor" OPERATOR(pg_catalog.=) OLD."total_amount_minor"
     AND NEW."currency" OPERATOR(pg_catalog.=) OLD."currency"
     AND (NEW."lines_sealed" OR NOT OLD."lines_sealed") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_order_financial_immutable: an order keeps its parties, total, currency and seal from placement (UPDATE refused)'
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
