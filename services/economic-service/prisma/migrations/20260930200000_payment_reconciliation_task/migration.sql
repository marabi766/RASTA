-- =============================================================================
-- economic-service — the durable queue behind an unfinished refund
-- (ADR-064 step B1; docs/23 D-035)
--
-- B0 (#143) made a refund fail safe: the amount is held before the provider is
-- asked, and an outcome the ledger could not record leaves a marker on the
-- intent's `failure_reason`. Nothing found those markers again. This table is
-- what does: one task per intent whose money a refund may have stranded,
-- written in the same transaction as the hold or the marker, and closed in the
-- same transaction as the outcome. A crash therefore never leaves a marker
-- without its task. The sweeper (B2) and the operator path (B3) work from it.
--
-- The markers stay where B0 put them (ADR-064 § 8, amended): they describe the
-- money. Scheduling — when to look again, who holds the task, how often it was
-- tried, whether a person has it — is this table's, and does not touch the
-- intent's row or its lifecycle CHECK.
--
-- One open task per intent (`ux_payment_reconciliation_open`): an outcome
-- recorded later reschedules the task already there. A DONE task is history;
-- the next refund of the same intent opens a new one.
--
-- `organization_id` is the tenant of the intent, and the foreign key binds the
-- task to that intent in that tenant, as in #148's reconciliation queue.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

-- CreateEnum
CREATE TYPE "PaymentReconciliationKind" AS ENUM ('REFUND', 'UNCREDITED_REFUND');

-- CreateEnum
CREATE TYPE "PaymentReconciliationStatus" AS ENUM ('PENDING', 'ESCALATED', 'DONE');

-- The target of the task's composite foreign key: an intent, in its tenant.
CREATE UNIQUE INDEX "payment_intent_organization_id_id_key" ON "payment_intent"("organization_id", "id");

-- CreateTable
CREATE TABLE "payment_reconciliation_task" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "kind" "PaymentReconciliationKind" NOT NULL,
    "status" "PaymentReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "lease_until" TIMESTAMP(3),
    "lease_token" TEXT,
    "last_outcome" TEXT,
    "correlation_id" TEXT NOT NULL,
    "escalated_at" TIMESTAMP(3),
    "resolution" TEXT,
    "resolved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "done_at" TIMESTAMP(3),

    CONSTRAINT "payment_reconciliation_task_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "payment_reconciliation_task" ADD CONSTRAINT "payment_reconciliation_task_organization_id_payment_intent_fkey" FOREIGN KEY ("organization_id", "payment_intent_id") REFERENCES "payment_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- At most one open task per intent: what makes opening one idempotent.
CREATE UNIQUE INDEX "ux_payment_reconciliation_open"
    ON "payment_reconciliation_task" ("payment_intent_id")
 WHERE "status" <> 'DONE';

-- What the sweeper scans: due, pending tasks, oldest first. ESCALATED tasks
-- are a person's and are not scanned.
CREATE INDEX "ix_payment_reconciliation_due"
    ON "payment_reconciliation_task" ("next_attempt_at")
 WHERE "status" = 'PENDING';

ALTER TABLE "payment_reconciliation_task" ADD CONSTRAINT "ck_payment_reconciliation_attempts_nonneg"
  CHECK ("attempts" >= 0);

-- Outcomes and resolutions are closed codes, never a provider's message: a
-- message may carry an instrument reference (AGENTS.md S-09).
ALTER TABLE "payment_reconciliation_task" ADD CONSTRAINT "ck_payment_reconciliation_codes"
  CHECK (("last_outcome" IS NULL OR "last_outcome" ~ '^[A-Z][A-Z_]{0,63}$')
     AND ("resolution" IS NULL OR "resolution" ~ '^[A-Z][A-Z_]{0,63}$'));

ALTER TABLE "payment_reconciliation_task" ADD CONSTRAINT "ck_payment_reconciliation_text_not_blank"
  CHECK (btrim("correlation_id") <> '' AND ("resolved_by" IS NULL OR btrim("resolved_by") <> ''));

-- DONE names when, how and by whom, and only DONE does.
ALTER TABLE "payment_reconciliation_task" ADD CONSTRAINT "ck_payment_reconciliation_done_complete"
  CHECK (("status" = 'DONE') = ("done_at" IS NOT NULL)
     AND ("status" = 'DONE') = ("resolution" IS NOT NULL)
     AND ("status" = 'DONE') = ("resolved_by" IS NOT NULL));

-- ESCALATED names when. The time stays on a task resolved after it, as history.
ALTER TABLE "payment_reconciliation_task" ADD CONSTRAINT "ck_payment_reconciliation_escalated"
  CHECK ("status" <> 'ESCALATED' OR "escalated_at" IS NOT NULL);

-- A lease is a time and the token that fences its holder, or neither; and a
-- finished task has no holder.
ALTER TABLE "payment_reconciliation_task" ADD CONSTRAINT "ck_payment_reconciliation_lease_pair"
  CHECK (num_nonnulls("lease_until", "lease_token") IN (0, 2)
     AND ("status" <> 'DONE' OR "lease_token" IS NULL));

-- Backfill: every intent B0 already left marked gets its task, due now. The id
-- is derived from the intent's, so a re-run adds nothing and the row is
-- traceable; tasks opened by the application are `PRT_<ULID>`.
INSERT INTO "payment_reconciliation_task"
    ("id", "organization_id", "payment_intent_id", "kind", "next_attempt_at",
     "last_outcome", "correlation_id", "created_at", "updated_at")
SELECT 'PRT_' || pi."id",
       pi."organization_id",
       pi."id",
       CASE WHEN pi."status" = 'AUTHORIZED'
            THEN 'UNCREDITED_REFUND'::"PaymentReconciliationKind"
            ELSE 'REFUND'::"PaymentReconciliationKind" END,
       CURRENT_TIMESTAMP,
       pi."failure_reason",
       -- `payment_intent` does not forbid a blank one; this table does.
       COALESCE(NULLIF(btrim(pi."correlation_id"), ''), 'MIGRATION-20260930200000'),
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM "payment_intent" pi
 WHERE (pi."status" = 'CAPTURED'
        AND pi."failure_reason" IN ('REFUND_REQUESTED', 'REFUND_UNKNOWN',
                                    'REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING'))
    OR (pi."status" = 'AUTHORIZED' AND pi."failure_reason" = 'CAPTURED_REFUND_UNKNOWN')
ON CONFLICT DO NOTHING;
