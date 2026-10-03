-- =============================================================================
-- economic-service — a refund decline is announced once (ADR-064 § 9)
--
-- `PAYMENT_REFUND_FAILED` is enqueued in the transaction that returns a
-- declined refund's hold. A business refusal releases the request's
-- idempotency key, so the same request can run again: a new hold, the provider
-- asked with the same refund key and answering with its cached decline, the
-- hold returned again — and, before this table, a second event for the same
-- provider outcome (Codex on #210).
--
-- One row per (intent, provider refund key) whose decline was announced. The
-- row is written in the same transaction as the event, `ON CONFLICT DO
-- NOTHING`, and the event is enqueued only when the row was new: the primary
-- key, not a read, is what keeps a replay or a concurrent transaction from
-- announcing the same decline twice. A distinct provider attempt key, should
-- one ever be used, is a new row and its own event.
--
-- A row and not an idempotent outbox insert: the outbox allocates the event's
-- stream sequence (ADR-051 B3) before the row is built, so a conflicting
-- insert would have to give a number back or leave a gap.
--
-- `organization_id` leads the key (docs/05 § 5.2) and the composite foreign
-- key binds the row to its intent in that tenant, as the reconciliation tables
-- do. `announced_at` is an instant, so TIMESTAMPTZ.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

-- CreateTable
CREATE TABLE "payment_refund_decline" (
    "organization_id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "provider_refund_key" TEXT NOT NULL,
    "announced_by" TEXT NOT NULL,
    "announced_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_refund_decline_pkey" PRIMARY KEY ("organization_id","payment_intent_id","provider_refund_key")
);

-- AddForeignKey
ALTER TABLE "payment_refund_decline" ADD CONSTRAINT "payment_refund_decline_organization_id_payment_intent_id_fkey" FOREIGN KEY ("organization_id", "payment_intent_id") REFERENCES "payment_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "payment_refund_decline" ADD CONSTRAINT "ck_payment_refund_decline_text_not_blank"
  CHECK (btrim("provider_refund_key") <> '' AND btrim("announced_by") <> '');
