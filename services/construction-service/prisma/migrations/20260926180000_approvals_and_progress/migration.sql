-- =============================================================================
-- construction-service — configurable approvals and progress reports
-- (CON-001 PR 2, ADR-063, docs/24 Q-70 to Q-73)
--
-- approval_policy and approval_policy_step are configuration as data: which
-- approvals a lifecycle step needs, from which (organization, role), above
-- which estimate. approval is one policy step snapshotted into one round of
-- one project; progress_report is what an executing project reports.
--
-- Every child references its parent by (organization_id, parent_id), so a
-- row can never point at another tenant's project or policy.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ApprovalPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('QUEUED', 'PENDING', 'GRANTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ProgressReportStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'DISCARDED');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "approval_round" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "approval_policy" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workflow_key" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "status" "ApprovalPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "label" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "is_sample" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3),
    "activated_by" TEXT,
    "retired_at" TIMESTAMP(3),
    "retired_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policy_step" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "approval_type" TEXT NOT NULL,
    "authority_organization_id" TEXT NOT NULL,
    "authority_role" TEXT NOT NULL,
    "authority_label" TEXT NOT NULL,
    "min_amount_minor" BIGINT,
    "max_amount_minor" BIGINT,

    CONSTRAINT "approval_policy_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "workflow_key" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "step_order" INTEGER NOT NULL,
    "policy_id" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "approval_type" TEXT NOT NULL,
    "authority_organization_id" TEXT NOT NULL,
    "authority_role" TEXT NOT NULL,
    "authority_label" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL,
    "requested_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "decision_number" TEXT,
    "conditions" TEXT,
    "reason" TEXT,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_report" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "progress_basis_points" INTEGER NOT NULL,
    "materials" TEXT,
    "machinery" TEXT,
    "labor" TEXT,
    "obstacles" TEXT,
    "assets_used" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "ProgressReportStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "submitted_by" TEXT,
    "discarded_at" TIMESTAMP(3),
    "discarded_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "progress_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_approval_policy_org_key_status" ON "approval_policy"("organization_id", "workflow_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_policy_org_id" ON "approval_policy"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_policy_version" ON "approval_policy"("organization_id", "workflow_key", "policy_version");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_policy_step_order" ON "approval_policy_step"("organization_id", "policy_id", "step_order");

-- CreateIndex
CREATE INDEX "ix_approval_org_project_round" ON "approval"("organization_id", "project_id", "round");

-- CreateIndex
CREATE INDEX "ix_approval_authority_inbox" ON "approval"("authority_organization_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_round_step" ON "approval"("organization_id", "project_id", "workflow_key", "round", "step_order");

-- CreateIndex
CREATE INDEX "ix_progress_org_project_status" ON "progress_report"("organization_id", "project_id", "status", "id");

-- AddForeignKey
ALTER TABLE "approval_policy_step" ADD CONSTRAINT "approval_policy_step_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "approval_policy"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "project"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "approval_policy"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "progress_report" ADD CONSTRAINT "progress_report_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "project"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Invariants the database keeps
-- =============================================================================

ALTER TABLE "project" ADD CONSTRAINT "ck_project_approval_round_nonneg"
  CHECK ("approval_round" >= 0);

-- ---- approval_policy ----------------------------------------------------------

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_text_not_blank"
  CHECK (btrim("workflow_key") <> '' AND btrim("label") <> '' AND btrim("rationale") <> ''
         AND btrim("created_by") <> '' AND btrim("created_correlation_id") <> '');

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_versions_positive"
  CHECK ("policy_version" >= 1 AND "version" >= 1);

-- Activation names who and when, exactly when the policy has left DRAFT;
-- retirement names who and when, exactly when it is RETIRED.
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_activation_complete"
  CHECK (num_nonnulls("activated_at", "activated_by") IN (0, 2)
         AND (("status" = 'DRAFT') = ("activated_at" IS NULL)));

ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_retirement_complete"
  CHECK (num_nonnulls("retired_at", "retired_by") IN (0, 2)
         AND (("status" = 'RETIRED') = ("retired_at" IS NOT NULL))
         AND ("retired_at" IS NULL OR "retired_at" >= "activated_at"));

-- At most one policy in force per (organization, workflow key).
CREATE UNIQUE INDEX "ux_approval_policy_active"
    ON "approval_policy" ("organization_id", "workflow_key")
 WHERE "status" = 'ACTIVE';

-- ---- approval_policy_step -----------------------------------------------------

ALTER TABLE "approval_policy_step" ADD CONSTRAINT "ck_step_order_positive"
  CHECK ("step_order" >= 1);

ALTER TABLE "approval_policy_step" ADD CONSTRAINT "ck_step_text_not_blank"
  CHECK (btrim("approval_type") <> '' AND btrim("authority_organization_id") <> ''
         AND btrim("authority_role") <> '' AND btrim("authority_label") <> '');

-- The oversight role has aggregate access only; it can never be an authority.
ALTER TABLE "approval_policy_step" ADD CONSTRAINT "ck_step_authority_not_oversight"
  CHECK ("authority_role" <> 'AUDITOR');

-- Bounds are non-negative, and a range with both bounds is non-empty.
ALTER TABLE "approval_policy_step" ADD CONSTRAINT "ck_step_amount_range"
  CHECK (("min_amount_minor" IS NULL OR "min_amount_minor" >= 0)
         AND ("max_amount_minor" IS NULL OR "max_amount_minor" >= 0)
         AND ("min_amount_minor" IS NULL OR "max_amount_minor" IS NULL
              OR "min_amount_minor" < "max_amount_minor"));

-- ---- approval -----------------------------------------------------------------

ALTER TABLE "approval" ADD CONSTRAINT "ck_approval_positions_positive"
  CHECK ("round" >= 1 AND "step_order" >= 1 AND "policy_version" >= 1 AND "version" >= 1);

ALTER TABLE "approval" ADD CONSTRAINT "ck_approval_authority_not_oversight"
  CHECK ("authority_role" <> 'AUDITOR');

-- A step that has been asked carries the moment it was asked; a queued one does not.
ALTER TABLE "approval" ADD CONSTRAINT "ck_approval_requested_when_asked"
  CHECK (("status" = 'QUEUED') = ("requested_at" IS NULL)
         OR ("status" = 'SUPERSEDED'));

-- A decision names who and when — exactly for GRANTED and REJECTED — and is
-- never earlier than the request it answers.
ALTER TABLE "approval" ADD CONSTRAINT "ck_approval_decision_complete"
  CHECK (num_nonnulls("decided_at", "decided_by") IN (0, 2)
         AND (("status" IN ('GRANTED', 'REJECTED')) = ("decided_at" IS NOT NULL))
         AND ("decided_at" IS NULL OR ("requested_at" IS NOT NULL AND "decided_at" >= "requested_at")));

-- A rejection says why; conditions and a decision number belong to a decision.
ALTER TABLE "approval" ADD CONSTRAINT "ck_approval_rejection_has_reason"
  CHECK ("status" <> 'REJECTED' OR ("reason" IS NOT NULL AND btrim("reason") <> ''));

ALTER TABLE "approval" ADD CONSTRAINT "ck_approval_decision_fields"
  CHECK (("decision_number" IS NULL AND "conditions" IS NULL) OR "decided_at" IS NOT NULL);

ALTER TABLE "approval" ADD CONSTRAINT "ck_approval_superseded_complete"
  CHECK (("status" = 'SUPERSEDED') = ("superseded_at" IS NOT NULL));

-- One step asked at a time per project and workflow (sequential, Q-70).
CREATE UNIQUE INDEX "ux_approval_one_pending"
    ON "approval" ("organization_id", "project_id", "workflow_key")
 WHERE "status" = 'PENDING';

-- ---- progress_report ----------------------------------------------------------

ALTER TABLE "progress_report" ADD CONSTRAINT "ck_progress_basis_points_range"
  CHECK ("progress_basis_points" BETWEEN 0 AND 10000);

ALTER TABLE "progress_report" ADD CONSTRAINT "ck_progress_text_not_blank"
  CHECK (("materials" IS NULL OR btrim("materials") <> '')
         AND ("machinery" IS NULL OR btrim("machinery") <> '')
         AND ("labor" IS NULL OR btrim("labor") <> '')
         AND ("obstacles" IS NULL OR btrim("obstacles") <> '')
         AND btrim("created_by") <> '' AND btrim("updated_by") <> '');

ALTER TABLE "progress_report" ADD CONSTRAINT "ck_progress_assets_bounded"
  CHECK (cardinality("assets_used") <= 100);

ALTER TABLE "progress_report" ADD CONSTRAINT "ck_progress_submission_complete"
  CHECK (num_nonnulls("submitted_at", "submitted_by") IN (0, 2)
         AND (("status" = 'SUBMITTED') = ("submitted_at" IS NOT NULL)));

ALTER TABLE "progress_report" ADD CONSTRAINT "ck_progress_discard_complete"
  CHECK (num_nonnulls("discarded_at", "discarded_by") IN (0, 2)
         AND (("status" = 'DISCARDED') = ("discarded_at" IS NOT NULL)));

ALTER TABLE "progress_report" ADD CONSTRAINT "ck_progress_version_positive"
  CHECK ("version" >= 1);
