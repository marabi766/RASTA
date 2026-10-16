-- =============================================================================
-- contract-service — statement submission and the two approval chains' snapshot (CON-003 PR 5,
-- ADR-068 § 5, docs/24 Q-96 (1) and (2), Q-100 (4)).
--
--   * `approval_policy` governs two more workflows: `contract.statement.technical` and
--     `contract.statement.financial` — the steps of each chain, in order, as (organization, role)
--     rows the governed employer's union or the platform writes and the platform approves, four eyes
--     (Q-70 (7)), exactly like `contract.signature`. No row is written here: no policy, no
--     submission (422).
--   * `approval_policy_step` gains optional amount bounds (`min_amount_minor` inclusive,
--     `max_amount_minor` exclusive), for the statement chains only: a step applies to a statement
--     whose gross falls within them (the construction-service rule, Q-70 (3); the basis is Q-134).
--     One step per (organization, role) now holds for signing policies only: two steps of a
--     statement chain may name the same authority, for two different people.
--   * `statement_line.milestone_id` — a line may refer to a planned milestone of its own contract.
--   * `statement_approval_step` — the snapshot of both chains, taken when the statement is submitted:
--     every step of the policy in force for each chain that applies to the statement's gross, with
--     the policy's id and version. Written in the transaction that submits the statement and never
--     changed, so a policy changed later never changes the chain a statement is decided on.
--   * `statement` gains the number of steps each chain was snapshotted with (null while DRAFT), and
--     `statement_guard` opens exactly one transition: DRAFT > SUBMITTED. At commit the snapshot is
--     checked whole: one policy per chain, as many rows as the statement records, every step of that
--     policy that applies, and every milestone the lines refer to marked referenced.
--   * `milestone_guard` lets a milestone be marked referenced (`first_referenced_at`, once) only by
--     the submission of a statement whose line refers to it, changing nothing else (Q-100 (4)).
--
-- Recording the decisions of either chain, and anything after SUBMITTED, is the next change.
-- Every instant is TIMESTAMPTZ(3) (D-048).
--
--   statement transitions: DRAFT>SUBMITTED
-- =============================================================================

-- ---- approval_policy: the statement chains ------------------------------------

ALTER TABLE "approval_policy" DROP CONSTRAINT "ck_policy_workflow_key";
ALTER TABLE "approval_policy" ADD CONSTRAINT "ck_policy_workflow_key"
  CHECK ("workflow_key" IN ('contract.signature', 'contract.statement.technical',
                            'contract.statement.financial'));

-- ---- approval_policy_step: amount bounds, statement chains only ------------------

ALTER TABLE "approval_policy_step"
  ADD COLUMN "min_amount_minor" BIGINT,
  ADD COLUMN "max_amount_minor" BIGINT;

-- `min` inclusive, `max` exclusive, both optional; a step with neither applies to every statement.
ALTER TABLE "approval_policy_step" ADD CONSTRAINT "ck_step_amount_bounds"
  CHECK (("min_amount_minor" IS NULL OR "min_amount_minor" >= 0)
         AND ("max_amount_minor" IS NULL OR "max_amount_minor" > 0)
         AND ("min_amount_minor" IS NULL OR "max_amount_minor" IS NULL
              OR "min_amount_minor" < "max_amount_minor"));

-- One authority, one step — for signing only. A signing policy's steps are alternatives, so naming
-- an (organization, role) twice says nothing; a statement chain's steps are asked in order, and two
-- of them may name the same (organization, role) for two different people (the separation of those
-- people is enforced when they decide). Kept for signing by `approval_policy_step_guard` below; step
-- order stays unique for every workflow (`ux_approval_policy_step_order`).
DROP INDEX "ux_approval_policy_step_authority";

-- A step is part of the policy it belongs to: written with it, while it is a draft, and never
-- changed or removed. Amount bounds belong to the statement chains: a signing step has none. A
-- signing policy names each authority once: the policy row is locked first, so two transactions
-- adding steps to one policy are checked one after the other.
CREATE OR REPLACE FUNCTION "approval_policy_step_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "workflow_key" INTO parent FROM "approval_policy"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."policy_id"
       FOR UPDATE;
    IF NOT FOUND OR parent."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ck_step_policy_draft: steps are written with a draft policy only'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."min_amount_minor" IS NOT NULL OR NEW."max_amount_minor" IS NOT NULL)
       AND parent."workflow_key" NOT IN ('contract.statement.technical', 'contract.statement.financial') THEN
      RAISE EXCEPTION 'ck_step_bounds_statement_only: only a statement chain''s step has amount bounds'
        USING ERRCODE = 'check_violation';
    END IF;
    -- `ck_step_authority_not_oversight` refuses the same row; this says why, for a statement chain.
    IF parent."workflow_key" IN ('contract.statement.technical', 'contract.statement.financial')
       AND NEW."authority_role" IN ('AUDITOR', 'SYSTEM_ADMIN') THEN
      RAISE EXCEPTION 'ck_step_authority_not_oversight: a statement chain step is never the oversight role (Q-96 (1)) nor the platform operator: the platform creates no legal authority, so it approves no tenant''s statement (CLAUDE.md principle 9)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF parent."workflow_key" = 'contract.signature' AND EXISTS (
      SELECT 1 FROM "approval_policy_step"
       WHERE "organization_id" = NEW."organization_id" AND "policy_id" = NEW."policy_id"
         AND "authority_organization_id" = NEW."authority_organization_id"
         AND "authority_role" = NEW."authority_role"
    ) THEN
      RAISE EXCEPTION 'ck_step_signing_authority_once: a signing policy names each authority once'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_step_immutable: a policy step is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ---- statement: the chains' step counts -----------------------------------------

ALTER TABLE "statement"
  ADD COLUMN "technical_step_count" INTEGER,
  ADD COLUMN "financial_step_count" INTEGER;

-- Set with the transition to SUBMITTED, and only then: how many steps each chain was snapshotted
-- with. At least one each — a chain with no step is no approval at all.
ALTER TABLE "statement" ADD CONSTRAINT "ck_statement_chain_counts"
  CHECK ((("status" = 'DRAFT') = ("technical_step_count" IS NULL))
         AND (("status" = 'DRAFT') = ("financial_step_count" IS NULL))
         AND ("technical_step_count" IS NULL OR "technical_step_count" >= 1)
         AND ("financial_step_count" IS NULL OR "financial_step_count" >= 1));

-- A statement belongs to a SIGNED contract and is born a DRAFT; what it says never changes; and the
-- one transition open is DRAFT > SUBMITTED, on a contract still SIGNED, with the chains' counts
-- (`statement.state-machine.ts` declares the same table). Once submitted, who submitted it and the
-- counts never change either. The snapshot itself is checked at commit
-- (`statement_submission_consistent`).
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
    IF OLD."status" <> 'DRAFT' AND (
         NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
         OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
         OR NEW."submitted_by_issuer" IS DISTINCT FROM OLD."submitted_by_issuer"
         OR NEW."submitted_by_subject" IS DISTINCT FROM OLD."submitted_by_subject"
         OR NEW."technical_step_count" IS DISTINCT FROM OLD."technical_step_count"
         OR NEW."financial_step_count" IS DISTINCT FROM OLD."financial_step_count")
    THEN
      RAISE EXCEPTION 'ck_statement_submission_immutable: who submitted a statement, when, and its chains never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'SUBMITTED') THEN
      RAISE EXCEPTION 'ck_statement_transition: % to % is not a statement transition', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_statement_contract_signed: a statement is submitted on a signed contract'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_statement_not_erasable: a statement is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ---- statement_line: the milestone a line refers to ------------------------------

ALTER TABLE "statement_line" ADD COLUMN "milestone_id" TEXT;

CREATE INDEX "ix_statement_line_milestone" ON "statement_line"("organization_id", "milestone_id");

ALTER TABLE "statement_line" ADD CONSTRAINT "statement_line_organization_id_milestone_id_fkey"
  FOREIGN KEY ("organization_id", "milestone_id") REFERENCES "milestone"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- As in 20261015120000, and a line's milestone is a milestone of the line's own contract.
CREATE OR REPLACE FUNCTION "statement_part_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  rule RECORD;
  milestone_contract text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "contract_id", "status", "gross_minor" INTO parent FROM "statement"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."statement_id";
    IF NOT FOUND OR parent."contract_id" <> NEW."contract_id" OR parent."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ck_statement_part_draft: lines and deductions are written to a draft statement of this contract'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_TABLE_NAME = 'statement_line' THEN
      IF NEW."milestone_id" IS NOT NULL THEN
        SELECT "contract_id" INTO milestone_contract FROM "milestone"
         WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."milestone_id";
        IF milestone_contract IS DISTINCT FROM NEW."contract_id" THEN
          RAISE EXCEPTION 'ck_statement_line_milestone: a line refers to a milestone of its own contract'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
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

-- ---- milestone: referenced by a submitted statement, once ---------------------------

-- As in 20261007100000, and one more change: a milestone becomes referenced (`first_referenced_at`,
-- null to an instant, once) only when a submitted statement has a line that refers to it, and that
-- change moves nothing else but the version. From then on it never changes.
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
    IF NEW."first_referenced_at" IS NOT NULL THEN
      IF NEW."title" IS DISTINCT FROM OLD."title"
         OR NEW."planned_date" IS DISTINCT FROM OLD."planned_date"
         OR NEW."planned_share_bp" IS DISTINCT FROM OLD."planned_share_bp"
         OR NEW."updated_at" IS DISTINCT FROM OLD."updated_at"
         OR NEW."updated_by" IS DISTINCT FROM OLD."updated_by"
      THEN
        RAISE EXCEPTION 'ck_milestone_reference_only: marking a milestone referenced changes nothing else'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM "statement_line" l
          JOIN "statement" s ON s."organization_id" = l."organization_id" AND s."id" = l."statement_id"
         WHERE l."organization_id" = NEW."organization_id" AND l."milestone_id" = NEW."id"
           AND s."status" <> 'DRAFT'
      ) THEN
        RAISE EXCEPTION 'ck_milestone_referenced_by_submission: a milestone is referenced by a submitted statement''s line'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
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

-- ---- statement_approval_step: the chains as they stood at submission -----------------

-- CreateTable
CREATE TABLE "statement_approval_step" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "policy_id" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "authority_organization_id" TEXT NOT NULL,
    "authority_role" TEXT NOT NULL,
    "authority_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "statement_approval_step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_statement_approval_step" ON "statement_approval_step"("organization_id", "statement_id", "chain", "step_order");
CREATE INDEX "ix_statement_approval_step_policy" ON "statement_approval_step"("organization_id", "policy_id");

-- AddForeignKey
ALTER TABLE "statement_approval_step" ADD CONSTRAINT "statement_approval_step_organization_id_statement_id_fkey"
  FOREIGN KEY ("organization_id", "statement_id") REFERENCES "statement"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "statement_approval_step" ADD CONSTRAINT "statement_approval_step_organization_id_policy_id_fkey"
  FOREIGN KEY ("organization_id", "policy_id") REFERENCES "approval_policy"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "statement_approval_step" ADD CONSTRAINT "ck_statement_approval_step_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("statement_id") <> '' AND btrim("policy_id") <> ''
         AND btrim("authority_organization_id") <> '' AND btrim("authority_role") <> ''
         AND btrim("authority_label") <> '');

-- Never the oversight role (Q-96 (1)), and never the platform operator: the platform creates no
-- legal authority of its own (CLAUDE.md principle 9), so it is no approver of a tenant's statement
-- (Q-96 (1), as clarified for CON-003 PR 5) — as `ck_step_authority_not_oversight` says for policies.
ALTER TABLE "statement_approval_step" ADD CONSTRAINT "ck_statement_approval_step_terms"
  CHECK ("chain" IN ('TECHNICAL', 'FINANCIAL') AND "step_order" >= 1 AND "policy_version" >= 1
         AND "authority_role" NOT IN ('AUDITOR', 'SYSTEM_ADMIN'));

-- A snapshot row is written to a statement in the transaction that submits it, and is a step of the
-- policy in force for its chain, as that policy says it, that applies to the statement's gross, and
-- that names an organization other than the contractor's: the contractor never approves its own
-- statement. It is never changed or removed.
CREATE FUNCTION "statement_approval_step_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  contractor text;
  chain_key text;
  policy RECORD;
  step RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "contract_id", "status", "gross_minor", "submitted_at" INTO parent FROM "statement"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."statement_id";
    IF NOT FOUND OR parent."contract_id" <> NEW."contract_id" OR parent."status" <> 'SUBMITTED'
       OR NEW."created_at" IS DISTINCT FROM parent."submitted_at" THEN
      RAISE EXCEPTION 'ck_statement_approval_step_submission: a chain is snapshotted when its statement is submitted'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Assigned first: an IF condition ends at its first THEN, a CASE's included.
    chain_key := CASE NEW."chain" WHEN 'TECHNICAL' THEN 'contract.statement.technical'
                                  ELSE 'contract.statement.financial' END;
    SELECT "status", "workflow_key", "policy_version" INTO policy FROM "approval_policy"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."policy_id";
    IF NOT FOUND OR policy."status" <> 'ACTIVE' OR policy."policy_version" <> NEW."policy_version"
       OR policy."workflow_key" <> chain_key THEN
      RAISE EXCEPTION 'ck_statement_approval_step_policy: a chain is the policy in force for it, at its version'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "authority_organization_id", "authority_role", "authority_label",
           "min_amount_minor", "max_amount_minor" INTO step FROM "approval_policy_step"
     WHERE "organization_id" = NEW."organization_id" AND "policy_id" = NEW."policy_id"
       AND "step_order" = NEW."step_order";
    IF NOT FOUND
       OR step."authority_organization_id" <> NEW."authority_organization_id"
       OR step."authority_role" <> NEW."authority_role"
       OR step."authority_label" <> NEW."authority_label"
       OR (step."min_amount_minor" IS NOT NULL AND parent."gross_minor" < step."min_amount_minor")
       OR (step."max_amount_minor" IS NOT NULL AND parent."gross_minor" >= step."max_amount_minor") THEN
      RAISE EXCEPTION 'ck_statement_approval_step_applies: a chain step is a step of its policy, as written, that applies to the gross'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "contractor_organization_id" INTO contractor FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF contractor IS NULL OR contractor = NEW."authority_organization_id" THEN
      RAISE EXCEPTION 'ck_statement_approval_step_not_contractor: the contractor never approves its own statement'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_statement_approval_step_immutable: a statement''s approval chains are never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_statement_approval_step_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "statement_approval_step"
  FOR EACH ROW EXECUTE FUNCTION "statement_approval_step_guard"();

CREATE TRIGGER "tg_statement_approval_step_no_truncate"
  BEFORE TRUNCATE ON "statement_approval_step"
  FOR EACH STATEMENT EXECUTE FUNCTION "statement_approval_step_guard"();

-- ---- the submission, whole, at commit ---------------------------------------------

-- A submitted statement carries both chains, whole, from the transaction that submitted it: for each
-- chain exactly the number of rows the statement records, all of one policy, and as many as that
-- policy has steps that apply to the gross (none left out); and every milestone its lines refer to is
-- marked referenced. A row added in a later transaction no longer matches the count.
CREATE FUNCTION "statement_submission_consistent"() RETURNS trigger AS $$
DECLARE
  target text;
  recorded RECORD;
  chain_name text;
  expected integer;
  rows_count integer;
  policies integer;
  chain_policy text;
  applicable integer;
BEGIN
  -- Two assignments, not one CASE: a field the row does not have must never be named.
  IF TG_TABLE_NAME = 'statement' THEN
    target := NEW."id";
  ELSE
    target := NEW."statement_id";
  END IF;
  SELECT "status", "gross_minor", "technical_step_count", "financial_step_count" INTO recorded
    FROM "statement"
   WHERE "organization_id" = NEW."organization_id" AND "id" = target;
  FOREACH chain_name IN ARRAY ARRAY['TECHNICAL', 'FINANCIAL'] LOOP
    expected := CASE chain_name WHEN 'TECHNICAL' THEN recorded."technical_step_count"
                                ELSE recorded."financial_step_count" END;
    SELECT count(*), count(DISTINCT "policy_id"), min("policy_id")
      INTO rows_count, policies, chain_policy
      FROM "statement_approval_step"
     WHERE "organization_id" = NEW."organization_id" AND "statement_id" = target
       AND "chain" = chain_name;
    SELECT count(*) INTO applicable FROM "approval_policy_step"
     WHERE "organization_id" = NEW."organization_id" AND "policy_id" = chain_policy
       AND ("min_amount_minor" IS NULL OR recorded."gross_minor" >= "min_amount_minor")
       AND ("max_amount_minor" IS NULL OR recorded."gross_minor" < "max_amount_minor");
    IF expected IS NULL OR rows_count <> expected OR policies <> 1 OR applicable <> rows_count THEN
      RAISE EXCEPTION 'ck_statement_submission_consistent: a submitted statement carries each approval chain whole, from one policy, as it was submitted (% chain)', chain_name
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM "statement_line" l
      JOIN "milestone" m ON m."organization_id" = l."organization_id" AND m."id" = l."milestone_id"
     WHERE l."organization_id" = NEW."organization_id" AND l."statement_id" = target
       AND m."first_referenced_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'ck_statement_submission_milestones: a submitted statement''s milestones are marked referenced'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_statement_submission_consistent"
  AFTER UPDATE ON "statement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT')
  EXECUTE FUNCTION "statement_submission_consistent"();

CREATE CONSTRAINT TRIGGER "tg_statement_approval_step_consistent"
  AFTER INSERT ON "statement_approval_step"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "statement_submission_consistent"();
