-- =============================================================================
-- economic-service — find intents with an unfinished refund without a scan
-- (ADR-064 step B2)
--
-- The payment reconciler heals its queue every sweep: an intent carrying one
-- of B0's refund markers with no open task gets one (Codex on #161, HIGH 1).
-- That query runs every interval over every tenant; without this index it
-- reads all of `payment_intent`. The predicate is exactly the heal query's, so
-- the index holds only the handful of intents a refund left unfinished, and is
-- empty in the normal case.
--
-- Single-column and partial, like the reconciliation queue's own due index:
-- a system job's lookup, never reachable from a tenant request, so it does not
-- lead with `organization_id` (the tenant-index-order check flags composite
-- indexes only).
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE INDEX "ix_payment_intent_unfinished_refund"
    ON "payment_intent" ("created_at")
 WHERE ("status" = 'CAPTURED'
        AND "failure_reason" IN ('REFUND_REQUESTED', 'REFUND_UNKNOWN',
                                 'REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING'))
    OR ("status" = 'AUTHORIZED' AND "failure_reason" = 'CAPTURED_REFUND_UNKNOWN');
