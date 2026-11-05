-- =============================================================================
-- saga_unconfirmed_call: a saga call to economic-service owed from the moment
-- economic-service may hold a dispute until its release is confirmed (FU-104).
--
-- The alert on an unconfirmed dispute release read a counter's rate. Rounds need
-- a worker, so with workers stopped it cleared with the funds still held. It now
-- reads this table, through a gauge the API process samples, once the order's
-- dispute is decided. Nothing is backfilled: a dispute economic-service was told of
-- before this runs is recorded when the saga first calls to release it.
--
-- New table only: nothing existing is rewritten or locked beyond the foreign
-- key's brief SHARE ROW EXCLUSIVE on "order". The runtime role's DML comes from
-- the schema's default privileges (D-045), as for every other table.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE TABLE "saga_unconfirmed_call" (
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),

    CONSTRAINT "saga_unconfirmed_call_pkey" PRIMARY KEY ("organization_id","order_id","operation","subject")
);

-- What the sampler walks: only what is still open, however many have ended.
CREATE INDEX "ix_saga_unconfirmed_call_open" ON "saga_unconfirmed_call"("opened_at")
  WHERE "confirmed_at" IS NULL;

ALTER TABLE "saga_unconfirmed_call" ADD CONSTRAINT "fk_saga_unconfirmed_call_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- A blank subject would make every call of an order answer for every other.
ALTER TABLE "saga_unconfirmed_call" ADD CONSTRAINT "ck_saga_unconfirmed_call_not_blank"
  CHECK (length(btrim("operation")) > 0 AND length(btrim("subject")) > 0);
