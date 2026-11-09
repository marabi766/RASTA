-- D-156: the database, not only pricing.ts, refuses an order line at a price its offer never
-- published at the version the line names.
--
-- uq_offer_price_history_price is the key the foreign key needs: PostgreSQL references only a
-- unique set of columns, and (offer_id, version) is already unique (uq_offer_price_version), so
-- this index can never refuse a row that one accepts.
--
-- No organization_id in either key: the line is the buyer's and the history row is the
-- supplier's, so the two never share a tenant (the tenant link of each is its own FK).
--
-- ON DELETE RESTRICT: a history row a line agreed to outlives every attempt to remove it — by
-- hand, or through fk_offer_price_history_tenant's cascade from its offer (which order_line's own
-- order_line_offer_id_fkey already restricts). ON UPDATE RESTRICT: the row is immutable anyway
-- (next migration). NOT VALID then VALIDATE, as D-119: an existing line no history row describes
-- aborts the whole migration (the precheck before this one names them); none is relabelled.
BEGIN;
SET LOCAL lock_timeout = '3s';
CREATE UNIQUE INDEX "uq_offer_price_history_price"
  ON "offer_price_history" ("offer_id", "version", "unit_price_minor", "currency");
ALTER TABLE "order_line" ADD CONSTRAINT "fk_order_line_price_history"
  FOREIGN KEY ("offer_id", "offer_version", "unit_price_minor", "currency")
  REFERENCES "offer_price_history" ("offer_id", "version", "unit_price_minor", "currency")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "order_line" VALIDATE CONSTRAINT "fk_order_line_price_history";
COMMIT;
