-- =============================================================================
-- economic-service — operator resolutions of an unknown refund, four-eyes
-- (ADR-064 § 6, step B3; Q-82; PM ruling Q-B3)
--
-- When the reconciler cannot learn what the provider did with a refund
-- attempt, it escalates the task and the refund's amount stays held. A person
-- then resolves it on evidence from the provider. Resolving moves money, so it
-- takes two people:
--
--   - a resolver PROPOSES (`PENDING_APPROVAL`): the provider's outcome as the
--     evidence shows it, a pattern-checked evidence reference and a reason.
--     Nothing moves.
--   - a second resolver — neither the proposer nor the intent's creator —
--     APPROVES or REJECTS it. Only an approval moves money, through the same
--     apply function a provider answer goes through, under the same locks.
--
-- One pending proposal per task (`ux_payment_resolution_pending`). An approved
-- or rejected row is history. `four_eyes` records whether separation applied:
-- it is false only where configuration allows it (development and test), and
-- the separation CHECK holds whenever it is true.
--
-- `reason` is free text and stays here, under authorization. The events carry
-- codes, both actors and the evidence reference only (AGENTS.md S-09).
-- =============================================================================
SET LOCAL lock_timeout = '3s';

-- CreateEnum
CREATE TYPE "PaymentResolutionStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentResolutionOutcome" AS ENUM ('REFUNDED', 'DECLINED', 'NOT_REACHED');

-- The target of the resolution's composite foreign key: a task, in its tenant.
CREATE UNIQUE INDEX "payment_reconciliation_task_organization_id_id_key" ON "payment_reconciliation_task"("organization_id", "id");

-- CreateTable
CREATE TABLE "payment_reconciliation_resolution" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "status" "PaymentResolutionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "provider_outcome" "PaymentResolutionOutcome" NOT NULL,
    "evidence_reference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "four_eyes" BOOLEAN NOT NULL,
    "proposed_by" TEXT NOT NULL,
    "proposed_at" TIMESTAMP(3) NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_reconciliation_resolution_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "payment_reconciliation_resolution" ADD CONSTRAINT "payment_reconciliation_resolution_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "payment_reconciliation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_reconciliation_resolution" ADD CONSTRAINT "payment_reconciliation_resolution_organization_id_payment__fkey" FOREIGN KEY ("organization_id", "payment_intent_id") REFERENCES "payment_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- At most one proposal awaiting approval per task.
CREATE UNIQUE INDEX "ux_payment_resolution_pending"
    ON "payment_reconciliation_resolution" ("task_id")
 WHERE "status" = 'PENDING_APPROVAL';

-- A reference to evidence — a ticket number, a document id — never free text.
ALTER TABLE "payment_reconciliation_resolution" ADD CONSTRAINT "ck_payment_resolution_evidence"
  CHECK ("evidence_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$');

ALTER TABLE "payment_reconciliation_resolution" ADD CONSTRAINT "ck_payment_resolution_text"
  CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500
     AND btrim("proposed_by") <> '' AND btrim("correlation_id") <> ''
     AND ("decided_by" IS NULL OR btrim("decided_by") <> '')
     AND ("decision_reason" IS NULL OR char_length(btrim("decision_reason")) BETWEEN 3 AND 500));

-- A decision names who and when, and only a decision does.
ALTER TABLE "payment_reconciliation_resolution" ADD CONSTRAINT "ck_payment_resolution_decided"
  CHECK (("status" = 'PENDING_APPROVAL') = ("decided_by" IS NULL)
     AND ("status" = 'PENDING_APPROVAL') = ("decided_at" IS NULL));

-- Separation of duties: under four-eyes the decider is never the proposer.
ALTER TABLE "payment_reconciliation_resolution" ADD CONSTRAINT "ck_payment_resolution_four_eyes"
  CHECK (NOT "four_eyes" OR "decided_by" IS NULL OR "decided_by" <> "proposed_by");
