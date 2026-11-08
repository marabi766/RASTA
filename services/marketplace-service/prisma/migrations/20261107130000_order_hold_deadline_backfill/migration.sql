-- =============================================================================
-- marketplace-service: the audit trail of the legacy hold-deadline backfill (FU-234).
--
-- An order from before the fence (20261107120000_order_hold_fence) counts one send with no
-- deadline, so every send it makes now is refused (D-150) and its saga waits for good.
-- `src/ops/hold-deadline-backfill.ts`, run by an operator, gives such a row a deadline; this
-- table is what it changed: one row per order, written in the same statement as the
-- deadline, so an order is given one at most once and a rerun finds nothing to do.
--
-- New table: nothing existing is rewritten. The runtime role's DML comes from the
-- schema's default privileges (D-045).
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE TABLE "order_hold_deadline_backfill" (
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hold_not_after" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "hold_send_claims" INTEGER NOT NULL,
    "economic_rule_since" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_hold_deadline_backfill_pkey" PRIMARY KEY ("organization_id","order_id")
);

ALTER TABLE "order_hold_deadline_backfill" ADD CONSTRAINT "fk_order_hold_deadline_backfill_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
