-- =============================================================================
-- economic-service — the reconciler's heal windows, without a scan
-- (ADR-064 step B2)
--
-- The payment reconciler heals its queue every sweep: an intent carrying one
-- of B0's refund markers with no open task gets one (Codex on #161, HIGH 1).
-- That query runs every interval over every tenant; without this index it
-- reads all of `payment_intent`. The predicate is exactly the heal query's, so
-- the index holds only the handful of intents a refund left unfinished, and is
-- empty in the normal case.
--
-- The heal pass reads each direction in `(created_at, id)` windows of at most
-- one batch after a cursor (Codex on #164, MEDIUM), so both indexes carry that
-- order and the work per sweep is one short range read, whatever the backlog.
--
-- Partial, and ordered by time rather than led by `organization_id`: a system
-- job's lookup across tenants, never reachable from a tenant request. (Were
-- economic in `check-tenant-index-order`'s service list, these two would be its
-- exemptions, for that reason; it is not today.)
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE INDEX "ix_payment_intent_unfinished_refund"
    ON "payment_intent" ("created_at", "id")
 WHERE ("status" = 'CAPTURED'
        AND "failure_reason" IN ('REFUND_REQUESTED', 'REFUND_UNKNOWN',
                                 'REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING'))
    OR ("status" = 'AUTHORIZED' AND "failure_reason" = 'CAPTURED_REFUND_UNKNOWN');

-- The other window: open tasks, in the same order.
CREATE INDEX "ix_payment_reconciliation_open_window"
    ON "payment_reconciliation_task" ("created_at", "id")
 WHERE "status" <> 'DONE';
