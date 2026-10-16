-- =============================================================================
-- Reverse of `migration.sql` (20261016120000_statement_submission, CON-003 PR 5).
--
-- Drops the approval chains' snapshot, the chains' step counts, a line's milestone and a policy
-- step's amount bounds; narrows `approval_policy` back to `contract.signature`; and restores the
-- previous `statement_guard` (no transition open), `statement_part_guard`, `milestone_guard` and
-- `approval_policy_step_guard`, and the one-step-per-authority index of every policy. Roll the code back first: it submits statements and writes all of
-- these.
--
-- **Refuses, and changes nothing, once any of this has been used.** A submitted statement is the
-- record of a claim put to the employer's approvers, under the chains it was submitted with; a
-- statement chain policy is governance a submission may have rested on; a line's milestone and a
-- step's bounds are part of what was written. Dropping any of it would leave a record no schema
-- explains. So this script stops, with a message, when any statement is no longer a DRAFT, any
-- snapshot row exists, any line refers to a milestone, any policy governs a statement chain, or any
-- step has amount bounds. On a database where none of it was used — draft statements, signing
-- policies, milestones all stay — it restores the previous schema exactly.
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check that RAISEs and every change commit
-- together or not at all. The `_prisma_migrations` row is removed last so the forward migration can
-- be re-applied.
-- =============================================================================

BEGIN;

-- Locked first, so nothing can be written between the check and the changes.
LOCK TABLE "statement_approval_step", "statement_line", "statement", "milestone",
  "approval_policy_step", "approval_policy"
  IN ACCESS EXCLUSIVE MODE;

DO $preflight_statement_submission$
DECLARE
  submitted integer;
  snapshots integer;
  referring integer;
  chain_policies integer;
  bounded integer;
BEGIN
  SELECT count(*) INTO submitted FROM "statement" WHERE "status" <> 'DRAFT';
  SELECT count(*) INTO snapshots FROM "statement_approval_step";
  SELECT count(*) INTO referring FROM "statement_line" WHERE "milestone_id" IS NOT NULL;
  SELECT count(*) INTO chain_policies FROM "approval_policy"
   WHERE "workflow_key" IN ('contract.statement.technical', 'contract.statement.financial');
  SELECT count(*) INTO bounded FROM "approval_policy_step"
   WHERE "min_amount_minor" IS NOT NULL OR "max_amount_minor" IS NOT NULL;
  IF submitted > 0 OR snapshots > 0 OR referring > 0 OR chain_policies > 0 OR bounded > 0 THEN
    RAISE EXCEPTION 'down refused: % submitted statement(s), % approval chain step(s), % line(s) referring to a milestone, % statement chain polic(ies) and % bounded policy step(s) exist; nothing was changed', submitted, snapshots, referring, chain_policies, bounded
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_statement_submission$;

-- ---- the snapshot and the commit check ---------------------------------------------

DROP TRIGGER IF EXISTS "tg_statement_approval_step_consistent" ON "statement_approval_step";
DROP TRIGGER IF EXISTS "tg_statement_submission_consistent" ON "statement";
DROP FUNCTION IF EXISTS "statement_submission_consistent"();

DROP TRIGGER IF EXISTS "tg_statement_approval_step_no_truncate" ON "statement_approval_step";
DROP TRIGGER IF EXISTS "tg_statement_approval_step_guard" ON "statement_approval_step";
DROP TABLE IF EXISTS "statement_approval_step";
DROP FUNCTION IF EXISTS "statement_approval_step_guard"();

-- ---- milestone_guard, as 20261007100000 wrote it -------------------------------------

CREATE OR REPLACE FUNCTION "milestone_guard"() RETURNS trigger AS $$
DECLARE
  parent_status "ContractStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_milestone_contract_signed: milestones are planned on a signed contract'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."first_referenced_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_milestone_born_unreferenced: a new milestone is referenced by nothing'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_milestone_origin_immutable: what a milestone belongs to never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."first_referenced_at" IS NOT NULL THEN
      RAISE EXCEPTION 'ck_milestone_referenced: a milestone a statement refers to never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_milestone_contract_signed: milestones are changed on a signed contract'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_milestone_not_erasable: a milestone is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ---- statement_line: no milestone; statement_part_guard as 20261015120000 wrote it -------

CREATE OR REPLACE FUNCTION "statement_part_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  rule RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "contract_id", "status", "gross_minor" INTO parent FROM "statement"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."statement_id";
    IF NOT FOUND OR parent."contract_id" <> NEW."contract_id" OR parent."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ck_statement_part_draft: lines and deductions are written to a draft statement of this contract'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_TABLE_NAME = 'statement_deduction' THEN
      SELECT "name", "rate_bp", "base", "retired_at" INTO rule FROM "deduction_rule"
       WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."deduction_rule_id";
      IF NOT FOUND OR rule."retired_at" IS NOT NULL
         OR rule."name" <> NEW."name" OR rule."rate_bp" <> NEW."rate_bp" OR rule."base" <> NEW."base" THEN
        RAISE EXCEPTION 'ck_statement_deduction_configured: a deduction is a rule in force, as it is configured'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."amount_minor"::numeric
         <> div(parent."gross_minor"::numeric * NEW."rate_bp" + 5000, 10000) THEN
        RAISE EXCEPTION 'ck_statement_deduction_amount: a deduction is its rate of the gross, rounded half up'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_statement_part_immutable: a statement''s lines and deductions are never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "statement_line" DROP CONSTRAINT IF EXISTS "statement_line_organization_id_milestone_id_fkey";
DROP INDEX IF EXISTS "ix_statement_line_milestone";
ALTER TABLE "statement_line" DROP COLUMN IF EXISTS "milestone_id";

-- ---- statement: no transition open; statement_guard as 20261015120000 wrote it ----------

CREATE OR REPLACE FUNCTION "statement_guard"() RETURNS trigger AS $$
DECLARE
  parent_status "ContractStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_statement_contract_signed: a statement belongs to a signed contract'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ck_statement_born_draft: a statement is drafted before it is submitted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
       OR NEW."statement_number" IS DISTINCT FROM OLD."statement_number"
       OR NEW."gross_minor" IS DISTINCT FROM OLD."gross_minor"
       OR NEW."deductions_minor" IS DISTINCT FROM OLD."deductions_minor"
       OR NEW."net_minor" IS DISTINCT FROM OLD."net_minor"
       OR NEW."line_count" IS DISTINCT FROM OLD."line_count"
       OR NEW."deduction_count" IS DISTINCT FROM OLD."deduction_count"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_statement_terms_immutable: what a statement says never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'ck_statement_transition: no statement transition is open yet (% to % refused)', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'ck_statement_not_erasable: a statement is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "statement" DROP CONSTRAINT IF EXISTS "ck_statement_chain_counts";
ALTER TABLE "statement" DROP COLUMN IF EXISTS "technical_step_count";
ALTER TABLE "statement" DROP COLUMN IF EXISTS "financial_step_count";

-- ---- approval_policy_step: no bounds; its guard as 20261005150000 wrote it ---------------

CREATE OR REPLACE FUNCTION "approval_policy_step_guard"() RETURNS trigger AS $$
DECLARE
  parent_status "ApprovalPolicyStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO parent_status FROM "approval_policy"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."policy_id";
    IF parent_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'ck_step_policy_draft: steps are written with a draft policy only'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_step_immutable: a policy step is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "approval_policy_step" DROP CONSTRAINT IF EXISTS "ck_step_amount_bounds";
ALTER TABLE "approval_policy_step" DROP COLUMN IF EXISTS "min_amount_minor";
ALTER TABLE "approval_policy_step" DROP COLUMN IF EXISTS "max_amount_minor";

-- One authority, one step, for every policy again. Only signing policies are left (the preflight
-- refused otherwise), and the guard kept each of them to one step per authority.
CREATE UNIQUE INDEX "ux_approval_policy_step_authority" ON "approval_policy_step"("organization_id", "policy_id", "authority_organization_id", "authority_role");

-- ---- approval_policy: the signing workflow only ----------------------------------------

ALTER TABLE "approval_policy" DROP CONSTRAINT "ck_policy_workflow_key";
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_workflow_key"
  CHECK ("workflow_key" IN ('contract.signature'));

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016120000_statement_submission';

COMMIT;
