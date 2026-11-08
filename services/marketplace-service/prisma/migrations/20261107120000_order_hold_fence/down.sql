-- Reverses 20261107120000_order_hold_fence.
--
-- Roll the code back first: the previous release neither reads nor writes these columns.
-- Refused while it would forget a fence still in use: a deadline on an order not yet ended,
-- or on a closed order with no obligation whose sends are not closed and whose deadline and
-- margin (1 h, `HOLD_FENCE` in economic-refusal.ts) have not passed, as a request sent
-- under it can still land. Wait for those, or end those orders, and run this again.

SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

LOCK TABLE "order" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "order"
    WHERE "hold_not_after" IS NOT NULL
      AND (
        "status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')
        OR ("economic_transaction_id" IS NULL
            AND "hold_sends_closed_at" IS NULL
            AND now() < "hold_not_after" + interval '1 hour')
      )
  ) THEN
    RAISE EXCEPTION 'order holds a hold deadline still in use; rolling back would forget it'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "trg_order_hold_fence_only_forward" ON "order";
DROP FUNCTION IF EXISTS order_hold_fence_only_forward();

ALTER TABLE "order"
  DROP COLUMN IF EXISTS "hold_sends_closed_at",
  DROP COLUMN IF EXISTS "hold_send_claims",
  DROP COLUMN IF EXISTS "hold_not_after";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261107120000_order_hold_fence';
