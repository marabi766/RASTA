-- =============================================================================
-- construction-service — contractor standing (CON-002 PR 5, ADR-067 § 4)
--
-- A read model of supplier-service's SUPPLIER_QUALIFIED / SUPPLIER_SUSPENDED /
-- SUPPLIER_REINSTATED. Folded so that any order and any replay gives the same
-- answer (see ContractorStandingRepository). No row means not eligible.
-- =============================================================================

-- CreateTable
CREATE TABLE "contractor_standing" (
    "organization_id" TEXT NOT NULL,
    "contracting_qualified_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_standing_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "contractor_suspension" (
    "suspension_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "suspended_at" TIMESTAMP(3),
    "reinstated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_suspension_pkey" PRIMARY KEY ("suspension_id")
);

-- CreateIndex
CREATE INDEX "ix_contractor_suspension_org" ON "contractor_suspension"("organization_id", "suspension_id");

ALTER TABLE "contractor_standing" ADD CONSTRAINT "ck_standing_org_not_blank"
  CHECK (btrim("organization_id") <> '');

ALTER TABLE "contractor_suspension" ADD CONSTRAINT "ck_suspension_text_not_blank"
  CHECK (btrim("suspension_id") <> '' AND btrim("organization_id") <> '');

-- An episode is not lifted before it began, when both are known.
ALTER TABLE "contractor_suspension" ADD CONSTRAINT "ck_suspension_order"
  CHECK ("suspended_at" IS NULL OR "reinstated_at" IS NULL OR "reinstated_at" >= "suspended_at");
