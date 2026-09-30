-- =============================================================================
-- construction-service — the durable work queue behind ORGANIZATION_MOVED (Q-83)
--
-- The Kafka handler does no network call: it inserts one task per policy an
-- organization move could have stranded, and returns. A sweeper claims due
-- tasks, asks organization-service, and suspends the policy in its own
-- transaction. A lookup that fails is retried later, so a policy is never
-- skipped for lack of time in a delivery (docs/23 D-041).
--
-- One open task per policy: a replayed or `.retry` delivery, or a second move
-- while the first is still queued, coalesces into the task already there
-- (`ux_policy_reconciliation_open`). A DONE task is history; the next move
-- creates a new one.
--
-- Coalescing must not lose a re-check: a move that lands while a sweeper holds
-- the task (its lookup may predate the move) bumps `generation` and makes the
-- task due again. The sweeper finishes the task only if the generation it
-- claimed is still the current one; otherwise it releases the task, and the
-- next sweep looks again.
--
-- `organization_id` is the tenant of the policy, and the foreign key binds the
-- task to that policy in that tenant, like every other child in this service.
-- =============================================================================

-- CreateEnum
CREATE TYPE "PolicyReconciliationStatus" AS ENUM ('PENDING', 'DONE');

-- CreateTable
CREATE TABLE "policy_reconciliation_task" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "union_id" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "moved_organization_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "status" "PolicyReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "lease_until" TIMESTAMP(3),
    "lease_token" TEXT,
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "done_at" TIMESTAMP(3),

    CONSTRAINT "policy_reconciliation_task_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "policy_reconciliation_task" ADD CONSTRAINT "policy_reconciliation_task_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "approval_policy"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- At most one open task per policy: what makes an enqueue idempotent.
CREATE UNIQUE INDEX "ux_policy_reconciliation_open"
    ON "policy_reconciliation_task" ("policy_id")
 WHERE "status" = 'PENDING';

-- What the sweeper scans: due, open tasks, oldest first.
CREATE INDEX "ix_policy_reconciliation_due"
    ON "policy_reconciliation_task" ("next_attempt_at")
 WHERE "status" = 'PENDING';

ALTER TABLE "policy_reconciliation_task" ADD CONSTRAINT "ck_reconciliation_text_not_blank"
  CHECK (btrim("union_id") <> '' AND btrim("source_event_id") <> ''
         AND btrim("moved_organization_id") <> '' AND btrim("correlation_id") <> '');

ALTER TABLE "policy_reconciliation_task" ADD CONSTRAINT "ck_reconciliation_attempts_nonneg"
  CHECK ("attempts" >= 0 AND "generation" >= 0);

-- DONE names when, and only DONE does.
ALTER TABLE "policy_reconciliation_task" ADD CONSTRAINT "ck_reconciliation_done_complete"
  CHECK (("status" = 'DONE') = ("done_at" IS NOT NULL));

-- A lease is a time and the token that fences its holder, or neither.
ALTER TABLE "policy_reconciliation_task" ADD CONSTRAINT "ck_reconciliation_lease_pair"
  CHECK (num_nonnulls("lease_until", "lease_token") IN (0, 2));
