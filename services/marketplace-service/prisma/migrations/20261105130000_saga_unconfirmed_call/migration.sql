-- =============================================================================
-- saga_unconfirmed_call: a saga call to economic-service owed from the moment
-- economic-service may hold a dispute until its release is confirmed (FU-104).
--
-- The alert on an unconfirmed dispute release read a counter's rate. Rounds need
-- a worker, so with workers stopped it cleared with the funds still held. It now
-- reads this table, through a gauge the API process samples, once the order's
-- dispute is decided. What is already owed at this point is written below, so that
-- an empty inventory can mean nothing is owed (#769 r1 F2).
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

-- What the sampler walks: only what is still open, however many have ended.
CREATE INDEX "ix_saga_unconfirmed_call_open" ON "saga_unconfirmed_call"("opened_at")
  WHERE "confirmed_at" IS NULL;

ALTER TABLE "saga_unconfirmed_call" ADD CONSTRAINT "fk_saga_unconfirmed_call_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- A blank subject would make every call of an order answer for every other.
ALTER TABLE "saga_unconfirmed_call" ADD CONSTRAINT "ck_saga_unconfirmed_call_not_blank"
  CHECK (length(btrim("operation")) > 0 AND length(btrim("subject")) > 0);

-- What this database can prove about a dispute from before this table: it cannot see
-- economic-service, so every dispute is owed unless proven otherwise, open ones too:
-- a saga that told economic-service and died will never call for it, and the count
-- skips it until it is decided. Proven: the order COMPLETED (economic-service settled
-- it) or CANCELLED (it compensated it), both final, or a release receipt on the order
-- from after the decision with no later telling of a dispute (the saga mirrors one at
-- a time, so such a receipt answers for every dispute decided before it). Unproven
-- counts: one economic-service never heard of shows as a row an operator reconciles
-- (the runbook), never as a silent hold.
--
-- Idempotent, and read by the runbook between these two markers: an old instance
-- may decide a dispute after this migration and before it stops.
-- BACKFILL BEGIN
INSERT INTO "saga_unconfirmed_call" ("organization_id", "order_id", "operation", "subject")
SELECT d."organization_id", d."order_id", 'resolveObligationDispute', d."id"
FROM "order_dispute" d
JOIN "order" o ON o."organization_id" = d."organization_id" AND o."id" = d."order_id"
WHERE o."status" NOT IN ('COMPLETED', 'CANCELLED')
  AND NOT EXISTS (
    SELECT 1 FROM "saga_step" s
    WHERE s."organization_id" = d."organization_id" AND s."order_id" = d."order_id"
      AND s."activity" = 'resolveObligationDispute'
      AND s."applied_at" >= d."resolved_at" AT TIME ZONE 'UTC'
      AND NOT EXISTS (
        SELECT 1 FROM "saga_step" t
        WHERE t."organization_id" = s."organization_id" AND t."order_id" = s."order_id"
          AND t."activity" = 'disputeObligation' AND t."applied_at" > s."applied_at"
      )
  )
ON CONFLICT DO NOTHING;
-- BACKFILL END
