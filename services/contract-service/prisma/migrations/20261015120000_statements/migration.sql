-- =============================================================================
-- contract-service — statements (CON-003 PR 4, ADR-068 § 5, docs/24 Q-96 and Q-97).
--
-- Four tables:
--
--   * `deduction_rule` — the configured deductions of an employer (Q-96 (6)): a name, a rate in
--     basis points and the base it applies to. Configuration as data: no type, rate or order of a
--     deduction is in code, and with no row a statement has no deduction (net = gross). This change
--     writes no row and opens no route that writes one: who configures them is docs/24 Q-125.
--   * `statement` — a statement of work on a SIGNED contract, made by the contractor: a number per
--     contract taken under the contract's row lock, and the gross, the deductions and the net in
--     minor units, net = gross − Σ deductions, computed once. It stays a DRAFT in this change: no
--     transition is open. Submission opens with the next change, together with the approval
--     policies of both chains and their snapshot at submission (ADR-068 § 5). The whole lifecycle
--     is declared now, because adding a value to a PostgreSQL enum cannot be reversed.
--   * `statement_line` — what the statement claims: a bounded description and a positive amount.
--   * `statement_deduction` — a configured deduction applied to a statement: the rule it came from,
--     and a snapshot of its name, rate and base with the amount, so what a statement says never
--     changes with the configuration.
--
-- What the statement says is written with it, in one transaction, and never changes: lines and
-- deductions are inserted only while it is a DRAFT and never updated or deleted, and at commit its
-- totals and its counts of lines and deductions are checked against them. A part added in a later
-- transaction, even a deduction of 0, no longer matches the counts. The ADR-068 § 5 cap invariant (`contract.approved_total_minor`,
-- `ck_contract_approved_cap`) is already in the database since 20261007100000; nothing here moves
-- it — only an APPROVED statement will. Every instant is TIMESTAMPTZ(3) (D-048).
--
--   statement transitions: (none)
-- =============================================================================

-- CreateEnum
CREATE TYPE "StatementStatus" AS ENUM (
  'DRAFT', 'SUBMITTED', 'TECHNICALLY_APPROVED', 'APPROVED', 'REJECTED'
);

-- ---- deduction_rule ----------------------------------------------------------

-- CreateTable
CREATE TABLE "deduction_rule" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "base" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "deduction_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_deduction_rule_org_id" ON "deduction_rule"("organization_id", "id");
-- One rule in force per name: a statement names a rule by id, a person reads it by name.
CREATE UNIQUE INDEX "ux_deduction_rule_name_active" ON "deduction_rule"("organization_id", "name")
  WHERE "retired_at" IS NULL;

ALTER TABLE "deduction_rule" ADD CONSTRAINT "ck_deduction_rule_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("created_by") <> '');

ALTER TABLE "deduction_rule" ADD CONSTRAINT "ck_deduction_rule_name"
  CHECK (btrim("name") <> '' AND length("name") <= 200
         AND "name" !~ '[؜‎‏‪-‮⁦-⁩]');

-- A rate is whole basis points of its base, never a fraction (AGENTS.md § 3). The one base the
-- service computes is the statement's gross: a deduction on another base is a migration, not a
-- setting.
ALTER TABLE "deduction_rule" ADD CONSTRAINT "ck_deduction_rule_rate"
  CHECK ("rate_bp" >= 1 AND "rate_bp" <= 10000 AND "base" = 'GROSS');

ALTER TABLE "deduction_rule" ADD CONSTRAINT "ck_deduction_rule_retired"
  CHECK ("retired_at" IS NULL OR "retired_at" >= "created_at");

-- A rule is configuration a statement may have applied: what it says never changes and it is never
-- removed. It is only taken out of force (`retired_at`, once).
CREATE FUNCTION "deduction_rule_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."rate_bp" IS DISTINCT FROM OLD."rate_bp"
       OR NEW."base" IS DISTINCT FROM OLD."base"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR (OLD."retired_at" IS NOT NULL AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at")
    THEN
      RAISE EXCEPTION 'ck_deduction_rule_immutable: a deduction rule never changes; it is only retired, once'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_deduction_rule_not_erasable: a deduction rule is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_deduction_rule_guard"
  BEFORE UPDATE OR DELETE ON "deduction_rule"
  FOR EACH ROW EXECUTE FUNCTION "deduction_rule_guard"();

CREATE TRIGGER "tg_deduction_rule_no_truncate"
  BEFORE TRUNCATE ON "deduction_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION "deduction_rule_guard"();

-- ---- statement ---------------------------------------------------------------

-- CreateTable
CREATE TABLE "statement" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "statement_number" INTEGER NOT NULL,
    "status" "StatementStatus" NOT NULL DEFAULT 'DRAFT',
    "gross_minor" BIGINT NOT NULL,
    "deductions_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "deduction_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_by" TEXT,
    "submitted_by_issuer" TEXT,
    "submitted_by_subject" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "statement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_statement_org_id" ON "statement"("organization_id", "id");
-- The number per contract, and the backstop of taking it under the contract's row lock.
CREATE UNIQUE INDEX "ux_statement_number" ON "statement"("organization_id", "contract_id", "statement_number");

-- AddForeignKey
ALTER TABLE "statement" ADD CONSTRAINT "statement_organization_id_contract_id_fkey"
  FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contract"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "statement" ADD CONSTRAINT "ck_statement_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("created_by") <> '' AND btrim("created_correlation_id") <> '');

ALTER TABLE "statement" ADD CONSTRAINT "ck_statement_number_positive"
  CHECK ("statement_number" >= 1 AND "version" >= 1);

-- Money is a bigint of minor units. A statement claims something (gross > 0); the net is the gross
-- less the deductions, and never negative (ADR-068 § 5).
ALTER TABLE "statement" ADD CONSTRAINT "ck_statement_amounts"
  CHECK ("gross_minor" > 0 AND "deductions_minor" >= 0
         AND "deductions_minor" <= "gross_minor"
         AND "net_minor" = "gross_minor" - "deductions_minor");

-- How many lines and deductions the statement was written with: part of what it says, so a part
-- added later, even a deduction of 0 that leaves every total as it was, no longer matches.
ALTER TABLE "statement" ADD CONSTRAINT "ck_statement_part_counts"
  CHECK ("line_count" >= 1 AND "deduction_count" >= 0);

-- Submitted exactly when it carries who submitted it and when — with the submitter's stable
-- identity, issuer and subject both (#188), for the separation of duties of the approvals. No
-- transition reaches SUBMITTED yet (`statement_guard`); the columns are the next change's.
ALTER TABLE "statement" ADD CONSTRAINT "ck_statement_submission"
  CHECK ((("status" = 'DRAFT') = ("submitted_at" IS NULL))
         AND ("submitted_at" IS NULL) = ("submitted_by" IS NULL)
         AND ("submitted_at" IS NULL) = ("submitted_by_issuer" IS NULL)
         AND ("submitted_at" IS NULL) = ("submitted_by_subject" IS NULL)
         AND ("submitted_by" IS NULL
              OR (btrim("submitted_by") <> '' AND btrim("submitted_by_issuer") <> ''
                  AND btrim("submitted_by_subject") <> ''))
         AND ("submitted_at" IS NULL OR "submitted_at" >= "created_at")
         AND "updated_at" >= "created_at");

-- A statement belongs to a SIGNED contract and is born a DRAFT; what it says never changes; and no
-- transition is open yet (`statement.state-machine.ts` declares the same empty table). The next
-- change replaces this function: it opens DRAFT > SUBMITTED together with the snapshot of both
-- approval chains at submission (ADR-068 § 5), so a statement is never SUBMITTED without one.
CREATE FUNCTION "statement_guard"() RETURNS trigger AS $$
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

CREATE TRIGGER "tg_statement_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "statement"
  FOR EACH ROW EXECUTE FUNCTION "statement_guard"();

CREATE TRIGGER "tg_statement_no_truncate"
  BEFORE TRUNCATE ON "statement"
  FOR EACH STATEMENT EXECUTE FUNCTION "statement_guard"();

-- ---- statement_line ----------------------------------------------------------

-- CreateTable
CREATE TABLE "statement_line" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "statement_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_statement_line_number" ON "statement_line"("organization_id", "statement_id", "line_number");

-- AddForeignKey
ALTER TABLE "statement_line" ADD CONSTRAINT "statement_line_organization_id_statement_id_fkey"
  FOREIGN KEY ("organization_id", "statement_id") REFERENCES "statement"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "statement_line" ADD CONSTRAINT "ck_statement_line_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("statement_id") <> '');

ALTER TABLE "statement_line" ADD CONSTRAINT "ck_statement_line_terms"
  CHECK ("line_number" >= 1 AND "amount_minor" > 0
         AND btrim("description") <> '' AND length("description") <= 500
         AND "description" !~ '[؜‎‏‪-‮⁦-⁩]');

-- ---- statement_deduction -----------------------------------------------------

-- CreateTable
CREATE TABLE "statement_deduction" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "deduction_rule_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "base" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "statement_deduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- A rule is applied to a statement at most once.
CREATE UNIQUE INDEX "ux_statement_deduction_rule" ON "statement_deduction"("organization_id", "statement_id", "deduction_rule_id");
CREATE INDEX "ix_statement_deduction_rule" ON "statement_deduction"("organization_id", "deduction_rule_id");

-- AddForeignKey
ALTER TABLE "statement_deduction" ADD CONSTRAINT "statement_deduction_organization_id_statement_id_fkey"
  FOREIGN KEY ("organization_id", "statement_id") REFERENCES "statement"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A deduction comes from a rule of the statement's own organization, and from nothing else (Q-96 (6)).
ALTER TABLE "statement_deduction" ADD CONSTRAINT "statement_deduction_organization_id_deduction_rule_id_fkey"
  FOREIGN KEY ("organization_id", "deduction_rule_id") REFERENCES "deduction_rule"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "statement_deduction" ADD CONSTRAINT "ck_statement_deduction_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("statement_id") <> '' AND btrim("deduction_rule_id") <> '');

ALTER TABLE "statement_deduction" ADD CONSTRAINT "ck_statement_deduction_amount"
  CHECK ("amount_minor" >= 0);

-- ---- lines and deductions: written with their statement, never changed ---------

-- A line or a deduction is written only to a DRAFT of the same contract, and never changed or
-- removed. A deduction is the rule in force as it is written — its name, rate and base — and the
-- amount that rate gives on the statement's gross, half up (the platform's one basis-point
-- rounding, `applyBasisPoints` in @rasta/contracts). The quotient is an exact integer division
-- (`div`): `/` on numeric rounds to a scale of its own choosing first, which for a gross of
-- 20000000000000000 at 10000 bp rounds …0.5 up before any floor could apply.
CREATE FUNCTION "statement_part_guard"() RETURNS trigger AS $$
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

CREATE TRIGGER "tg_statement_line_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "statement_line"
  FOR EACH ROW EXECUTE FUNCTION "statement_part_guard"();

CREATE TRIGGER "tg_statement_line_no_truncate"
  BEFORE TRUNCATE ON "statement_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "statement_part_guard"();

CREATE TRIGGER "tg_statement_deduction_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "statement_deduction"
  FOR EACH ROW EXECUTE FUNCTION "statement_part_guard"();

CREATE TRIGGER "tg_statement_deduction_no_truncate"
  BEFORE TRUNCATE ON "statement_deduction"
  FOR EACH STATEMENT EXECUTE FUNCTION "statement_part_guard"();

-- The totals and the parts agree, at commit (ADR-068 § 5, "computed once"): the gross is the sum of
-- the lines, the deductions total the sum of the deductions, and there are exactly as many lines
-- (at least one) and deductions as the statement was written with. A statement without its lines,
-- or any part added to it later — a deduction of 0 included — fails the transaction that wrote it.
CREATE FUNCTION "statement_totals_consistent"() RETURNS trigger AS $$
DECLARE
  target text;
  recorded RECORD;
  lines integer;
  lines_sum numeric;
  deductions integer;
  deductions_sum numeric;
BEGIN
  -- Two assignments, not one CASE: a field the row does not have must never be named.
  IF TG_TABLE_NAME = 'statement' THEN
    target := NEW."id";
  ELSE
    target := NEW."statement_id";
  END IF;
  SELECT "gross_minor", "deductions_minor", "line_count", "deduction_count" INTO recorded
    FROM "statement"
   WHERE "organization_id" = NEW."organization_id" AND "id" = target;
  SELECT count(*), coalesce(sum("amount_minor"), 0) INTO lines, lines_sum FROM "statement_line"
   WHERE "organization_id" = NEW."organization_id" AND "statement_id" = target;
  SELECT count(*), coalesce(sum("amount_minor"), 0) INTO deductions, deductions_sum
    FROM "statement_deduction"
   WHERE "organization_id" = NEW."organization_id" AND "statement_id" = target;
  IF lines = 0 OR lines <> recorded."line_count" OR deductions <> recorded."deduction_count"
     OR recorded."gross_minor"::numeric <> lines_sum
     OR recorded."deductions_minor"::numeric <> deductions_sum THEN
    RAISE EXCEPTION 'ck_statement_totals_consistent: a statement''s gross is the sum of its lines, its deductions the sum of its deductions, and it has the lines and deductions it was written with'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tg_statement_totals_consistent"
  AFTER INSERT ON "statement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "statement_totals_consistent"();

CREATE CONSTRAINT TRIGGER "tg_statement_line_totals_consistent"
  AFTER INSERT ON "statement_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "statement_totals_consistent"();

CREATE CONSTRAINT TRIGGER "tg_statement_deduction_totals_consistent"
  AFTER INSERT ON "statement_deduction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "statement_totals_consistent"();
