-- =============================================================================
-- saga_step: one row per order-saga activity that took effect (docs/23 D-053).
--
-- Temporal retries an activity whose completion it did not record (worker
-- crash or shutdown after the commit, a lost response). The retry used to
-- recognise its own earlier work only while the order still stood where the
-- step had sent it; once a party moved the order on, the retry was refused as
-- a business rule and the saga failed with the buyer's funds held. Each step
-- now writes this row in its own transaction, keyed by the identity Temporal
-- keeps across the retries of one scheduled activity, and a retry that finds
-- it answers what the first attempt answered.
--
-- New table only: nothing existing is rewritten or locked beyond the foreign
-- key's brief SHARE ROW EXCLUSIVE on "order". The runtime role's DML comes
-- from the schema's default privileges (D-045), as for every other table.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

-- CreateTable
CREATE TABLE "saga_step" (
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "step_key" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "result" JSONB,
    "applied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saga_step_pkey" PRIMARY KEY ("organization_id","order_id","step_key")
);

-- CreateIndex
CREATE INDEX "ix_saga_step_order" ON "saga_step"("order_id");

-- AddForeignKey
ALTER TABLE "saga_step" ADD CONSTRAINT "saga_step_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A blank key would make every step of an order answer for every other.
ALTER TABLE "saga_step" ADD CONSTRAINT "ck_saga_step_key_not_blank"
  CHECK (length(btrim("step_key")) > 0 AND length(btrim("activity")) > 0);
