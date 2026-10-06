-- =============================================================================
-- contract-service — a signing policy follows an organization move (CON-003 PR 2 review round 2;
-- Q-83, ADR-063, ADR-068 § 5): the shape construction-service gave its approval policies
-- (20260930130000_policy_suspension, _from_pending, _reconciliation_task).
--
-- An organization can be moved in the hierarchy (organization-service, ORGANIZATION_MOVED). A
-- policy a union wrote for an employer that is no longer beneath it must stop authorising
-- signatures. It is SUSPENDED — not deleted, not transferred — with who and why recorded, in the
-- transaction that finds it. A suspended policy is never reactivated: a new version goes through
-- the normal write / submit / approve flow. `ux_approval_policy_active` covers ACTIVE only, so
-- suspending frees the slot for the replacement; the signature guard already requires ACTIVE, so
-- the database refuses a signature under a suspended policy by itself.
--
-- A policy still PENDING_PLATFORM_APPROVAL can be suspended too: approval checks the hierarchy
-- before its own transaction, so a move can land between that check and the activation. Such a
-- policy was never approved and has no `activated_at`.
--
-- The durable work queue (`policy_reconciliation_task`): the Kafka handler makes no network call,
-- it queues one task per policy a move could have stranded; a sweeper claims due tasks, asks
-- organization-service and suspends. One open task per policy, so a replayed or `.retry` delivery
-- coalesces into the task already there.
--
-- ## The enum value and the constraints that name it
--
-- PostgreSQL allows ADD VALUE inside a transaction, but the new value cannot be *used* in it — and
-- a CHECK constraint that compares the enum column to 'SUSPENDED' uses it. The constraints below
-- therefore compare the status as text, which names the value without resolving it.
--
-- Every instant is TIMESTAMPTZ(3) (D-048).
-- =============================================================================

ALTER TYPE "ApprovalPolicyStatus" ADD VALUE 'SUSPENDED';

ALTER TABLE "approval_policy"
  ADD COLUMN "suspended_at" TIMESTAMPTZ(3),
  ADD COLUMN "suspended_by" TEXT,
  ADD COLUMN "suspension_reason" TEXT;

-- ACTIVE and RETIRED always name the platform approval; SUSPENDED may or may not (it was ACTIVE,
-- or still pending); every other state has none.
ALTER TABLE "approval_policy" DROP CONSTRAINT "ck_policy_activation_complete";
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_activation_complete"
  CHECK (num_nonnulls("activated_at", "activated_by") IN (0, 2)
         AND ("status"::text NOT IN ('ACTIVE', 'RETIRED') OR "activated_at" IS NOT NULL)
         AND ("status"::text IN ('ACTIVE', 'RETIRED', 'SUSPENDED') OR "activated_at" IS NULL)
         AND ("activated_at" IS NULL OR "activated_at" >= "submitted_at"));

-- Suspension names who, when and why, exactly when the policy is SUSPENDED.
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_suspension_complete"
  CHECK (num_nonnulls("suspended_at", "suspended_by", "suspension_reason") IN (0, 3)
         AND (("status"::text = 'SUSPENDED') = ("suspended_at" IS NOT NULL))
         AND ("suspension_reason" IS NULL OR btrim("suspension_reason") <> '')
         AND ("suspended_at" IS NULL OR "suspended_at" >= "submitted_at")
         AND ("suspended_at" IS NULL OR "activated_at" IS NULL OR "suspended_at" >= "activated_at"));

-- The guard as the signing_policy migration made it, now also: the suspension record is never
-- rewritten, and the two moves into SUSPENDED are declared.
--
--   transitions: DRAFT>PENDING_PLATFORM_APPROVAL PENDING_PLATFORM_APPROVAL>ACTIVE PENDING_PLATFORM_APPROVAL>REJECTED PENDING_PLATFORM_APPROVAL>SUSPENDED ACTIVE>RETIRED ACTIVE>SUSPENDED

CREATE OR REPLACE FUNCTION "approval_policy_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."author_organization_id" IS DISTINCT FROM OLD."author_organization_id"
       OR NEW."author_role" IS DISTINCT FROM OLD."author_role"
       OR NEW."workflow_key" IS DISTINCT FROM OLD."workflow_key"
       OR NEW."policy_version" IS DISTINCT FROM OLD."policy_version"
       OR NEW."label" IS DISTINCT FROM OLD."label"
       OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
       OR NEW."is_sample" IS DISTINCT FROM OLD."is_sample"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_by_issuer" IS DISTINCT FROM OLD."created_by_issuer"
       OR NEW."created_by_subject" IS DISTINCT FROM OLD."created_by_subject"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_policy_immutable: a policy is written once; a change is a new version'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A step already taken is not rewritten.
    IF (OLD."submitted_at" IS NOT NULL
        AND (NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
             OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
             OR NEW."submitted_by_issuer" IS DISTINCT FROM OLD."submitted_by_issuer"
             OR NEW."submitted_by_subject" IS DISTINCT FROM OLD."submitted_by_subject"))
       OR (OLD."activated_at" IS NOT NULL
           AND (NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
                OR NEW."activated_by" IS DISTINCT FROM OLD."activated_by"))
       OR (OLD."rejected_at" IS NOT NULL
           AND (NEW."rejected_at" IS DISTINCT FROM OLD."rejected_at"
                OR NEW."rejected_by" IS DISTINCT FROM OLD."rejected_by"
                OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"))
       OR (OLD."retired_at" IS NOT NULL
           AND (NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
                OR NEW."retired_by" IS DISTINCT FROM OLD."retired_by"))
       OR (OLD."suspended_at" IS NOT NULL
           AND (NEW."suspended_at" IS DISTINCT FROM OLD."suspended_at"
                OR NEW."suspended_by" IS DISTINCT FROM OLD."suspended_by"
                OR NEW."suspension_reason" IS DISTINCT FROM OLD."suspension_reason"))
    THEN
      RAISE EXCEPTION 'ck_policy_history_immutable: who took a step, and when, is never rewritten'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'PENDING_PLATFORM_APPROVAL')
                OR (OLD."status" = 'PENDING_PLATFORM_APPROVAL'
                    AND NEW."status" IN ('ACTIVE', 'REJECTED', 'SUSPENDED'))
                OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('RETIRED', 'SUSPENDED'))) THEN
      RAISE EXCEPTION 'ck_policy_transition: a policy cannot move from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_policy_not_erasable: a policy is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ---- the queue behind ORGANIZATION_MOVED ----------------------------------------

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
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "lease_token" TEXT,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "done_at" TIMESTAMPTZ(3),

    CONSTRAINT "policy_reconciliation_task_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey: the task is bound to its policy in the policy's tenant, like every child here.
ALTER TABLE "policy_reconciliation_task" ADD CONSTRAINT "policy_reconciliation_task_organization_id_policy_id_fkey"
  FOREIGN KEY ("organization_id", "policy_id") REFERENCES "approval_policy"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

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
