-- =============================================================================
-- construction-service — the tender aggregate (CON-002 PR 2, ADR-065)
--
-- One table. A tender references its project by the (organization, project)
-- pair, so a tender of organization A cannot point at a project of organization
-- B whatever a write path forgets. The whole lifecycle is in the enum now; PR 2
-- reaches DRAFT and CANCELLED, and later steps add commands, not enum values.
--
-- CHECKs compare `status::text` because a value added to an enum by a later
-- migration cannot be used in the transaction that adds it.
-- =============================================================================

-- CreateEnum
CREATE TYPE "TenderStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED', 'EVALUATING', 'EVALUATED', 'AWARDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProcurementNature" AS ENUM ('FORMAL_TENDER', 'INQUIRY', 'RFP', 'MARKETPLACE_DEAL');

-- CreateEnum
CREATE TYPE "TenderVisibility" AS ENUM ('PUBLIC', 'RESTRICTED');

-- CreateTable
CREATE TABLE "tender" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope_of_work" TEXT NOT NULL,
    "procurement_nature" "ProcurementNature",
    "visibility" "TenderVisibility",
    "bid_opening_at" TIMESTAMPTZ(3),
    "bid_closing_at" TIMESTAMPTZ(3),
    "status" "TenderStatus" NOT NULL DEFAULT 'DRAFT',
    "status_reason" TEXT,
    "status_reason_code" TEXT,
    "status_changed_at" TIMESTAMP(3) NOT NULL,
    "status_changed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_tender_org_id" ON "tender"("organization_id", "id");

-- CreateIndex
CREATE INDEX "ix_tender_org_status" ON "tender"("organization_id", "status", "id");

-- CreateIndex
CREATE INDEX "ix_tender_org_project_status" ON "tender"("organization_id", "project_id", "status");

-- AddForeignKey
ALTER TABLE "tender" ADD CONSTRAINT "tender_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "project"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_text_not_blank"
  CHECK (btrim("title") <> '' AND btrim("scope_of_work") <> '');

-- Every change names who made it (AGENTS.md S-06).
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("updated_by") <> ''
         AND btrim("status_changed_by") <> '' AND btrim("created_correlation_id") <> '');

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_timestamps_ordered"
  CHECK ("updated_at" >= "created_at" AND "status_changed_at" >= "created_at");

-- The bidding window is a window (ADR-065 § 2).
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_window_ordered"
  CHECK (("bid_opening_at" IS NULL AND "bid_closing_at" IS NULL)
         OR ("bid_opening_at" IS NOT NULL AND "bid_closing_at" IS NOT NULL
             AND "bid_opening_at" < "bid_closing_at"));

-- A tender that is or was open for bids has its nature, its visibility and its
-- window: nothing is published on a default (Q-03, Q-84).
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_published_complete"
  CHECK ("status"::text NOT IN ('PUBLISHED', 'CLOSED', 'EVALUATING', 'EVALUATED', 'AWARDED')
         OR ("procurement_nature" IS NOT NULL AND "visibility" IS NOT NULL
             AND "bid_opening_at" IS NOT NULL AND "bid_closing_at" IS NOT NULL));

-- A cancellation says why, in prose for the record and as a closed code for
-- the event; nothing else carries a reason.
ALTER TABLE "tender" ADD CONSTRAINT "ck_tender_cancellation_has_reason"
  CHECK (("status"::text = 'CANCELLED')
           = ("status_reason" IS NOT NULL AND btrim("status_reason") <> ''
              AND "status_reason_code" IS NOT NULL)
         AND ("status_reason_code" IS NULL
              OR "status_reason_code" IN ('OWNER_REQUEST', 'NO_QUALIFIED_BID')));
