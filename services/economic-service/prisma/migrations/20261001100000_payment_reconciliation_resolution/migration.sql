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
-- Who is compared by a STABLE identity as well as the platform user id: the
-- token's issuer and subject (Codex on #175, HIGH 1). A resolver must carry
-- the platform id (`rasta_uid`); the identity pair is what makes two tokens of
-- one person one person here.
--
-- Both tables are append-only at the database (Codex on #175, HIGH 2 and
-- MED 4): a resolution is never deleted, and is updated exactly once — from
-- PENDING_APPROVAL to its decision, nothing else changing; a requeue row is
-- never updated or deleted. They are the record of who did what on which
-- evidence; audit-service holds the events, not the reasons.
--
-- `reason` is free text and stays here, under authorization. The events carry
-- codes, ids, both actors and the evidence reference only (AGENTS.md S-09).
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
    "proposed_by_issuer" TEXT NOT NULL,
    "proposed_by_subject" TEXT NOT NULL,
    "proposed_at" TIMESTAMP(3) NOT NULL,
    "decided_by" TEXT,
    "decided_by_issuer" TEXT,
    "decided_by_subject" TEXT,
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
     AND btrim("proposed_by_issuer") <> '' AND btrim("proposed_by_subject") <> ''
     AND ("decided_by" IS NULL OR btrim("decided_by") <> '')
     AND ("decided_by_issuer" IS NULL OR btrim("decided_by_issuer") <> '')
     AND ("decided_by_subject" IS NULL OR btrim("decided_by_subject") <> '')
     AND ("decision_reason" IS NULL OR char_length(btrim("decision_reason")) BETWEEN 3 AND 500));

-- A decision names who and when, and only a decision does.
ALTER TABLE "payment_reconciliation_resolution" ADD CONSTRAINT "ck_payment_resolution_decided"
  CHECK (("status" = 'PENDING_APPROVAL') = ("decided_by" IS NULL)
     AND ("status" = 'PENDING_APPROVAL') = ("decided_by_issuer" IS NULL)
     AND ("status" = 'PENDING_APPROVAL') = ("decided_by_subject" IS NULL)
     AND ("status" = 'PENDING_APPROVAL') = ("decided_at" IS NULL));

-- Separation of duties: under four-eyes the decider is never the proposer —
-- neither by platform user id nor by the token's issuer and subject.
ALTER TABLE "payment_reconciliation_resolution" ADD CONSTRAINT "ck_payment_resolution_four_eyes"
  CHECK (NOT "four_eyes" OR "decided_by" IS NULL
      OR ("decided_by" <> "proposed_by"
          AND ("decided_by_issuer", "decided_by_subject")
              IS DISTINCT FROM ("proposed_by_issuer", "proposed_by_subject")));

-- Append-only: never deleted; updated once, from PENDING_APPROVAL to a
-- decision, with nothing but the decision columns changing.
CREATE OR REPLACE FUNCTION guard_payment_resolution_history() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_reconciliation_resolution is append-only: a resolution is never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status = 'PENDING_APPROVAL'
     OR (NEW.id, NEW.organization_id, NEW.payment_intent_id, NEW.task_id, NEW.provider_outcome,
         NEW.evidence_reference, NEW.reason, NEW.four_eyes, NEW.proposed_by, NEW.proposed_by_issuer,
         NEW.proposed_by_subject, NEW.proposed_at, NEW.correlation_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.payment_intent_id, OLD.task_id, OLD.provider_outcome,
         OLD.evidence_reference, OLD.reason, OLD.four_eyes, OLD.proposed_by, OLD.proposed_by_issuer,
         OLD.proposed_by_subject, OLD.proposed_at, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'payment_reconciliation_resolution is append-only: only a pending proposal is decided, once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_payment_resolution_append_only"
  BEFORE UPDATE OR DELETE ON "payment_reconciliation_resolution"
  FOR EACH ROW EXECUTE FUNCTION guard_payment_resolution_history();

-- -----------------------------------------------------------------------------
-- Requeues (Codex on #175, MED 4): who put a task back for the reconciler, and
-- why. The reason is free text, so it lives here — tenant-scoped and under
-- authorization — and never in a log or an event.
-- -----------------------------------------------------------------------------
CREATE TABLE "payment_reconciliation_requeue" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_by_issuer" TEXT NOT NULL,
    "requested_by_subject" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_reconciliation_requeue_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payment_reconciliation_requeue" ADD CONSTRAINT "payment_reconciliation_requeue_organization_id_task_id_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "payment_reconciliation_task"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "payment_reconciliation_requeue" ADD CONSTRAINT "payment_reconciliation_requeue_organization_id_payment_int_fkey" FOREIGN KEY ("organization_id", "payment_intent_id") REFERENCES "payment_intent"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "ix_payment_reconciliation_requeue_intent"
    ON "payment_reconciliation_requeue" ("organization_id", "payment_intent_id", "created_at");

ALTER TABLE "payment_reconciliation_requeue" ADD CONSTRAINT "ck_payment_requeue_text"
  CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500
     AND btrim("requested_by") <> '' AND btrim("requested_by_issuer") <> ''
     AND btrim("requested_by_subject") <> '' AND btrim("correlation_id") <> '');

CREATE OR REPLACE FUNCTION reject_payment_requeue_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payment_reconciliation_requeue is append-only: never UPDATE or DELETE'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_payment_requeue_append_only"
  BEFORE UPDATE OR DELETE ON "payment_reconciliation_requeue"
  FOR EACH ROW EXECUTE FUNCTION reject_payment_requeue_mutation();
