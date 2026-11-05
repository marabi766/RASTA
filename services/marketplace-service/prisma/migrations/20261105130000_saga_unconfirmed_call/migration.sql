-- =============================================================================
-- saga_unconfirmed_call: the durable record of a saga call to economic-service
-- whose outcome nothing has confirmed (FU-104). Written before the call, opened
-- again by every attempt, and closed only by that attempt's own confirmation, so
-- a call that failed, was never answered or was made by a saga now gone stays on
-- record with no worker or saga needed. This table records; it decides nothing.
--
-- New table: nothing existing is rewritten or locked beyond the foreign key's
-- brief SHARE ROW EXCLUSIVE on "order". The runtime role's DML comes from
-- the schema's default privileges (D-045), as for every other table.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE TABLE "saga_unconfirmed_call" (
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    -- Moves with every opening; only the opening's own attempt may confirm it.
    "generation" INTEGER NOT NULL DEFAULT 1,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),

    CONSTRAINT "saga_unconfirmed_call_pkey" PRIMARY KEY ("organization_id","order_id","operation","subject")
);

-- What a reader walks: only what is still open, however many have ended.
CREATE INDEX "ix_saga_unconfirmed_call_open" ON "saga_unconfirmed_call"("opened_at")
  WHERE "confirmed_at" IS NULL;

ALTER TABLE "saga_unconfirmed_call" ADD CONSTRAINT "fk_saga_unconfirmed_call_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- A blank subject would make every call of an order answer for every other.
ALTER TABLE "saga_unconfirmed_call" ADD CONSTRAINT "ck_saga_unconfirmed_call_not_blank"
  CHECK (length(btrim("operation")) > 0 AND length(btrim("subject")) > 0);

-- What was already owed when this table arrived: a row for EVERY dispute of an order
-- that has not finished. This database cannot see economic-service, and nothing in it
-- says which dispute a release receipt answered: a receipt names the order, it is
-- stamped by another clock than the decision, and it may be stored late or never. So
-- neither a receipt nor a time ends a dispute here (#769 r2 F2), only the order's own
-- end does: COMPLETED (economic-service settled it) or CANCELLED (it refunded it). Any
-- other status, FAILED included, proves nothing. A release that did happen shows as a
-- row: a saga still waiting closes its own, an operator reconciles the rest (the
-- runbook). A false row costs a look; a missing one leaves funds held in silence.
--
-- Idempotent, and read by the runbook between these two markers: an old instance
-- may decide a dispute after this migration and before it stops.
-- BACKFILL BEGIN
INSERT INTO "saga_unconfirmed_call" ("organization_id", "order_id", "operation", "subject")
SELECT d."organization_id", d."order_id", 'resolveObligationDispute', d."id"
FROM "order_dispute" d
JOIN "order" o ON o."organization_id" = d."organization_id" AND o."id" = d."order_id"
WHERE o."status" NOT IN ('COMPLETED', 'CANCELLED')
ON CONFLICT DO NOTHING;
-- BACKFILL END
