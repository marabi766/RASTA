-- D-119: additive, atomic tenant checks. Existing ID-only FKs remain for rollback.
-- Existing inconsistent rows abort validation; never relabel another tenant's data.
BEGIN;
CREATE UNIQUE INDEX "uq_offer_tenant_id" ON "offer" ("organization_id", "id");
CREATE UNIQUE INDEX "uq_order_tenant_id" ON "order" ("organization_id", "id");
CREATE UNIQUE INDEX "uq_review_tenant_order" ON "review" ("organization_id", "order_id");
ALTER TABLE "offer_price_history" ADD CONSTRAINT "fk_offer_price_history_tenant"
  FOREIGN KEY ("organization_id", "offer_id") REFERENCES "offer" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "order_line" ADD CONSTRAINT "fk_order_line_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "fulfillment" ADD CONSTRAINT "fk_fulfillment_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "order_status_history" ADD CONSTRAINT "fk_order_status_history_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "saga_step" ADD CONSTRAINT "fk_saga_step_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "order_dispute" ADD CONSTRAINT "fk_order_dispute_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "review" ADD CONSTRAINT "fk_review_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "offer_price_history" VALIDATE CONSTRAINT "fk_offer_price_history_tenant";
ALTER TABLE "order_line" VALIDATE CONSTRAINT "fk_order_line_tenant";
ALTER TABLE "fulfillment" VALIDATE CONSTRAINT "fk_fulfillment_tenant";
ALTER TABLE "order_status_history" VALIDATE CONSTRAINT "fk_order_status_history_tenant";
ALTER TABLE "saga_step" VALIDATE CONSTRAINT "fk_saga_step_tenant";
ALTER TABLE "order_dispute" VALIDATE CONSTRAINT "fk_order_dispute_tenant";
ALTER TABLE "review" VALIDATE CONSTRAINT "fk_review_tenant";
COMMIT;
