-- =============================================================================
-- construction-service — evaluation criteria as data (CON-002 PR 4a, ADR-067 § 1)
--
-- A criteria template (versioned, immutable rows) and a tender's own criteria,
-- copied from a template or written out while the tender is a DRAFT, and frozen
-- once it is not (threat C3, docs/09): a trigger refuses any insert, update or
-- delete on a tender's criteria after publication, whatever write path tries.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ScoringMethod" AS ENUM ('MANUAL_SCORE', 'PASS_FAIL');

-- CreateTable
CREATE TABLE "criteria_template" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "criteria" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,

    CONSTRAINT "criteria_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_criterion" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weight_bp" INTEGER NOT NULL,
    "scoring_method" "ScoringMethod" NOT NULL,
    "max_score" INTEGER NOT NULL,
    "template_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "tender_criterion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_criteria_template_label_version" ON "criteria_template"("organization_id", "label", "version");

-- CreateIndex
CREATE INDEX "ix_criteria_template_org_id" ON "criteria_template"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tender_criterion_code" ON "tender_criterion"("tender_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tender_criterion_position" ON "tender_criterion"("tender_id", "position");

-- CreateIndex
CREATE INDEX "ix_tender_criterion_org_tender" ON "tender_criterion"("organization_id", "tender_id");

-- AddForeignKey
ALTER TABLE "tender_criterion" ADD CONSTRAINT "tender_criterion_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tender"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

ALTER TABLE "criteria_template" ADD CONSTRAINT "ck_criteria_template_text_not_blank"
  CHECK (btrim("label") <> '');

ALTER TABLE "criteria_template" ADD CONSTRAINT "ck_criteria_template_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "criteria_template" ADD CONSTRAINT "ck_criteria_template_is_array"
  CHECK (jsonb_typeof("criteria") = 'array' AND jsonb_array_length("criteria") >= 1);

ALTER TABLE "criteria_template" ADD CONSTRAINT "ck_criteria_template_actor_recorded"
  CHECK (btrim("created_by") <> '' AND btrim("created_correlation_id") <> '');

ALTER TABLE "tender_criterion" ADD CONSTRAINT "ck_criterion_text_not_blank"
  CHECK (btrim("code") <> '' AND btrim("label") <> '');

ALTER TABLE "tender_criterion" ADD CONSTRAINT "ck_criterion_weight_range"
  CHECK ("weight_bp" BETWEEN 1 AND 10000);

ALTER TABLE "tender_criterion" ADD CONSTRAINT "ck_criterion_position_positive"
  CHECK ("position" >= 1);

-- A score is a whole number of points above zero; a pass/fail criterion is
-- scored 0 or 1 (an arithmetic convention, not a legal one: Q-88).
ALTER TABLE "tender_criterion" ADD CONSTRAINT "ck_criterion_max_score"
  CHECK ("max_score" >= 1
         AND ("scoring_method"::text <> 'PASS_FAIL' OR "max_score" = 1));

ALTER TABLE "tender_criterion" ADD CONSTRAINT "ck_criterion_actor_recorded"
  CHECK (btrim("created_by") <> '');

-- =============================================================================
-- The freeze (threat C3): a tender's criteria change only while it is a DRAFT
-- =============================================================================

CREATE FUNCTION "tender_criterion_freeze"() RETURNS trigger AS $$
DECLARE
  current_status text;
  target_tender text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tender := OLD."tender_id";
  ELSE
    target_tender := NEW."tender_id";
  END IF;

  SELECT "status"::text INTO current_status FROM "tender" WHERE "id" = target_tender;

  -- No tender means the foreign key is about to refuse the row; let it.
  IF current_status IS NOT NULL AND current_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'ck_tender_criteria_frozen: the criteria of a tender that is % cannot change', current_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_criterion_freeze"
  BEFORE INSERT OR UPDATE OR DELETE ON "tender_criterion"
  FOR EACH ROW EXECUTE FUNCTION "tender_criterion_freeze"();
