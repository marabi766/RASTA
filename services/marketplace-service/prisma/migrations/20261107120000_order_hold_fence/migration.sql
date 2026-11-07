-- =============================================================================
-- marketplace-service: the hold's fence on the order row (PM decision D-144).
--
-- A run of the order saga cannot know what an earlier run sent: a Temporal reset forgets
-- the deadline it fixed, and a refusal to the new run says nothing of a request the old
-- one left in flight. So what a later run needs goes on the order, before the send:
--
--   hold_not_after        the deadline every request under the hold's key carries
--                         (economic-service refuses past it). Set once, never moved.
--   hold_send_claims      sends begun, counted before each leaves. Never falls.
--   hold_sends_closed_at  from here on no send may begin. Never reopened.
--
-- ## Orders no build that counts sends has placed
--
-- Nothing records whether their sagas sent, and those requests carry no deadline. So
-- `hold_send_claims` defaults to 1, a send with no deadline: nothing then proves absence on
-- such an order, existing or placed by an older build during the rollout, and it waits for
-- the drain in docs/runbooks/marketplace-saga-deploy.md rather than closing on an empty
-- lookup. Only `OrderService.place` writes 0.
--
-- Bounded: three columns with constant defaults (no rewrite), one function and one trigger.
-- =============================================================================
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

ALTER TABLE "order"
  ADD COLUMN "hold_not_after" TIMESTAMPTZ(3),
  ADD COLUMN "hold_send_claims" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "hold_sends_closed_at" TIMESTAMPTZ(3);

CREATE FUNCTION order_hold_fence_only_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.hold_not_after IS NOT NULL AND NEW.hold_not_after IS DISTINCT FROM OLD.hold_not_after)
     OR (OLD.hold_sends_closed_at IS NOT NULL
         AND NEW.hold_sends_closed_at IS DISTINCT FROM OLD.hold_sends_closed_at)
     OR NEW.hold_send_claims < OLD.hold_send_claims THEN
    RAISE EXCEPTION 'The hold fence of order % only moves forward', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_order_hold_fence_only_forward"
  BEFORE UPDATE OF "hold_not_after", "hold_send_claims", "hold_sends_closed_at" ON "order"
  FOR EACH ROW EXECUTE FUNCTION order_hold_fence_only_forward();
