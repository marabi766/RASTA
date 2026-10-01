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
CREATE UNIQUE INDEX "ux_tender_criterion_code" ON "tender_criterion"("organization_id", "tender_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tender_criterion_position" ON "tender_criterion"("organization_id", "tender_id", "position");

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

-- Both tenders a write touches are judged: an UPDATE that moves a criterion from
-- a published tender to a draft one (or the reverse) changes the criteria of both.
-- The tender rows are locked FOR SHARE, in id order, before the status is read, so
-- a publication in flight (which holds the row for update) is waited for rather
-- than raced: the write then sees PUBLISHED and is refused.
CREATE FUNCTION "tender_criterion_freeze"() RETURNS trigger AS $$
DECLARE
  tenders text[];
  frozen_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    tenders := ARRAY[NEW."tender_id"];
  ELSIF TG_OP = 'DELETE' THEN
    tenders := ARRAY[OLD."tender_id"];
  ELSE
    tenders := ARRAY[OLD."tender_id", NEW."tender_id"];
  END IF;

  PERFORM 1 FROM "tender" WHERE "id" = ANY (tenders) ORDER BY "id" FOR SHARE;

  SELECT "status"::text INTO frozen_status
    FROM "tender" WHERE "id" = ANY (tenders) AND "status"::text <> 'DRAFT' LIMIT 1;

  -- No tender means the foreign key is about to refuse the row; let it.
  IF frozen_status IS NOT NULL THEN
    RAISE EXCEPTION 'ck_tender_criteria_frozen: the criteria of a tender that is % cannot change', frozen_status
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

-- =============================================================================
-- A tender is published only with a complete set of criteria (ADR-067 § 1): at
-- least one, weights summing to exactly 10000 basis points. Kept here as well as
-- in the publish command, so a direct status update cannot publish without them.
-- The update holds the tender row, which the freeze trigger above makes every
-- criteria writer wait for, so the criteria cannot change between this check and
-- the commit.
-- =============================================================================

CREATE FUNCTION "tender_publish_requires_criteria"() RETURNS trigger AS $$
DECLARE
  criteria_count bigint;
  total_weight bigint;
BEGIN
  SELECT count(*), COALESCE(sum("weight_bp"), 0) INTO criteria_count, total_weight
    FROM "tender_criterion" WHERE "tender_id" = NEW."id";

  IF criteria_count < 1 OR total_weight <> 10000 THEN
    RAISE EXCEPTION 'ck_tender_publish_criteria: a tender is published with at least one criterion and weights summing to 10000 (has % criteria summing to %)',
      criteria_count, total_weight
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_publish_requires_criteria"
  BEFORE UPDATE OF "status" ON "tender"
  FOR EACH ROW
  WHEN (NEW."status"::text = 'PUBLISHED' AND OLD."status"::text <> 'PUBLISHED')
  EXECUTE FUNCTION "tender_publish_requires_criteria"();

-- =============================================================================
-- A tender's status moves only along the documented edges (ADR-065 § 1, the same
-- table as `TENDER_TRANSITIONS`): forward one step, or CANCELLED from any state
-- before AWARDED. In particular a published tender never returns to DRAFT, which
-- would lift the criteria freeze above; AWARDED and CANCELLED are terminal.
-- =============================================================================

CREATE FUNCTION "tender_status_transition_guard"() RETURNS trigger AS $$
BEGIN
  IF NOT (
       (OLD."status"::text = 'DRAFT'      AND NEW."status"::text IN ('PUBLISHED', 'CANCELLED'))
    OR (OLD."status"::text = 'PUBLISHED'  AND NEW."status"::text IN ('CLOSED', 'CANCELLED'))
    OR (OLD."status"::text = 'CLOSED'     AND NEW."status"::text IN ('EVALUATING', 'CANCELLED'))
    OR (OLD."status"::text = 'EVALUATING' AND NEW."status"::text IN ('EVALUATED', 'CANCELLED'))
    OR (OLD."status"::text = 'EVALUATED'  AND NEW."status"::text IN ('AWARDED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'ck_tender_status_transition: a tender cannot go from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_tender_status_transition"
  BEFORE UPDATE OF "status" ON "tender"
  FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "tender_status_transition_guard"();

-- =============================================================================
-- A criteria template is append-only: a new version is a new row. An edit or a
-- delete would change what a tender already copied from it claims to follow.
-- (The table's owner can still drop or disable this trigger: runtime and owner
-- roles are not yet split in this service, docs/23 D-045.)
-- =============================================================================

CREATE FUNCTION "criteria_template_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ck_criteria_template_immutable: a criteria template is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_criteria_template_append_only"
  BEFORE UPDATE OR DELETE ON "criteria_template"
  FOR EACH ROW EXECUTE FUNCTION "criteria_template_append_only"();

CREATE TRIGGER "tg_criteria_template_no_truncate"
  BEFORE TRUNCATE ON "criteria_template"
  FOR EACH STATEMENT EXECUTE FUNCTION "criteria_template_append_only"();
