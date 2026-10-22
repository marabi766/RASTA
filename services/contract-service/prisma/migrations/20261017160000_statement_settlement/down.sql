-- =============================================================================
-- Reverse of `migration.sql` (20261017160000_statement_settlement, CON-003 PR 6c).
--
-- Drops the settlement columns, rebuilds `StatementStatus` without SETTLED, and restores the previous
-- `statement_guard` (APPROVED final), `statement_decisions_consistent` and `contract_guard` (the
-- approved total over APPROVED statements; COMPLETED > SETTLED unconditioned). Roll the code back
-- first: it settles statements and contracts.
--
-- **Refuses, and changes nothing, once a statement has been settled.** A SETTLED statement is the
-- record that economic-service confirmed its obligation paid in full (I5), with the obligation, the
-- settlement and the amount; the older enum cannot hold the value, and turning it back into APPROVED
-- would say an approved statement was never paid when it was. So this script stops, with a message,
-- when any statement is SETTLED. On a database where none is it restores the previous schema exactly.
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check that RAISEs and every change commit
-- together or not at all. The `_prisma_migrations` row is removed last so the forward migration can
-- be re-applied.
-- =============================================================================

BEGIN;

-- Locked first, so nothing can be written between the check and the changes.
LOCK TABLE "statement", "contract" IN ACCESS EXCLUSIVE MODE;

DO $preflight_statement_settlement$
DECLARE
  settled integer;
BEGIN
  SELECT count(*) INTO settled FROM "statement" WHERE "status"::text = 'SETTLED';
  IF settled > 0 THEN
    RAISE EXCEPTION 'down refused: % settled statement(s) exist; nothing was changed', settled
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_statement_settlement$;

-- ---- the settlement columns -----------------------------------------------------------

DROP INDEX IF EXISTS "ix_statement_settleable";
DROP INDEX IF EXISTS "ux_statement_settlement_obligation";
ALTER TABLE "statement" DROP CONSTRAINT IF EXISTS "ck_statement_settlement";
ALTER TABLE "statement"
  DROP COLUMN IF EXISTS "settled_at",
  DROP COLUMN IF EXISTS "settlement_obligation_id",
  DROP COLUMN IF EXISTS "settlement_id",
  DROP COLUMN IF EXISTS "settled_amount_minor",
  DROP COLUMN IF EXISTS "settlement_event_id";

-- ---- the enum, without SETTLED ----------------------------------------------------------

-- Everything that names the column is dropped first and put back as 20261015120000_statements,
-- 20261016120000_statement_submission and 20261016180000_statement_decisions wrote it.
DROP TRIGGER IF EXISTS "tg_statement_decisions_consistent" ON "statement";
DROP TRIGGER IF EXISTS "tg_statement_submission_consistent" ON "statement";
ALTER TABLE "statement" DROP CONSTRAINT IF EXISTS "ck_statement_chain_counts";
ALTER TABLE "statement" DROP CONSTRAINT IF EXISTS "ck_statement_submission";
ALTER TABLE "statement" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "StatementStatus" RENAME TO "StatementStatus_with_settled";
CREATE TYPE "StatementStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'TECHNICALLY_APPROVED', 'APPROVED', 'REJECTED');
ALTER TABLE "statement"
  ALTER COLUMN "status" TYPE "StatementStatus"
  USING "status"::text::"StatementStatus";
ALTER TABLE "statement" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "StatementStatus_with_settled";

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

ALTER TABLE "statement" ADD CONSTRAINT "ck_statement_chain_counts"
  CHECK ((("status" = 'DRAFT') = ("technical_step_count" IS NULL))
         AND (("status" = 'DRAFT') = ("financial_step_count" IS NULL))
         AND ("technical_step_count" IS NULL OR "technical_step_count" >= 1)
         AND ("financial_step_count" IS NULL OR "financial_step_count" >= 1));

CREATE CONSTRAINT TRIGGER "tg_statement_submission_consistent"
  AFTER UPDATE ON "statement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT')
  EXECUTE FUNCTION "statement_submission_consistent"();

CREATE CONSTRAINT TRIGGER "tg_statement_decisions_consistent"
  AFTER UPDATE ON "statement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."status" <> 'DRAFT')
  EXECUTE FUNCTION "statement_decisions_consistent"();

-- ---- the guards, as 20261016180000_statement_decisions left them ---------------------------

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
    IF OLD."status" IN ('APPROVED', 'REJECTED') THEN
      RAISE EXCEPTION 'ck_statement_final: a % statement never changes', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
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
    -- A decision that completes nothing: the status stays, the version moves (checked at commit).
    IF NOT (NEW."status" = OLD."status" AND OLD."status" IN ('SUBMITTED', 'TECHNICALLY_APPROVED'))
       AND NOT ((OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[
         'DRAFT>SUBMITTED', 'SUBMITTED>TECHNICALLY_APPROVED', 'SUBMITTED>REJECTED',
         'TECHNICALLY_APPROVED>APPROVED', 'TECHNICALLY_APPROVED>REJECTED']))
    THEN
      RAISE EXCEPTION 'ck_statement_transition: % to % is not a statement transition', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- Every change is a submission or a decision, and each moves the version by one.
    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_statement_version: every change of a statement moves its version by one'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_statement_contract_signed: a statement is submitted and decided on a signed contract'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_statement_not_erasable: a statement is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "statement_decisions_consistent"() RETURNS trigger AS $$
DECLARE
  target text;
  recorded RECORD;
  technical_approved integer;
  financial_approved integer;
  rejected integer;
  decided integer;
  expected text;
  approved_sum numeric;
  approved_total bigint;
BEGIN
  -- Two assignments, not one CASE: a field the row does not have must never be named.
  IF TG_TABLE_NAME = 'statement' THEN
    target := NEW."id";
  ELSE
    target := NEW."statement_id";
  END IF;
  SELECT "status", "contract_id", "version", "technical_step_count", "financial_step_count"
    INTO recorded FROM "statement"
   WHERE "organization_id" = NEW."organization_id" AND "id" = target;
  SELECT count(*) FILTER (WHERE "chain" = 'TECHNICAL' AND "outcome" = 'APPROVED'),
         count(*) FILTER (WHERE "chain" = 'FINANCIAL' AND "outcome" = 'APPROVED'),
         count(*) FILTER (WHERE "outcome" = 'REJECTED'),
         count(*)
    INTO technical_approved, financial_approved, rejected, decided
    FROM "statement_decision"
   WHERE "organization_id" = NEW."organization_id" AND "statement_id" = target;
  IF rejected > 0 THEN
    expected := 'REJECTED';
  ELSIF financial_approved = recorded."financial_step_count" THEN
    expected := 'APPROVED';
  ELSIF technical_approved = recorded."technical_step_count" THEN
    expected := 'TECHNICALLY_APPROVED';
  ELSE
    expected := 'SUBMITTED';
  END IF;
  IF recorded."status"::text <> expected OR recorded."version" <> 2 + decided THEN
    RAISE EXCEPTION 'ck_statement_decisions_consistent: a statement''s status and version are what its decisions say'
      USING ERRCODE = 'check_violation';
  END IF;
  IF expected = 'APPROVED' THEN
    SELECT coalesce(sum("gross_minor"), 0) INTO approved_sum FROM "statement"
     WHERE "organization_id" = NEW."organization_id" AND "contract_id" = recorded."contract_id"
       AND "status" = 'APPROVED';
    SELECT "approved_total_minor" INTO approved_total FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = recorded."contract_id";
    IF approved_total IS DISTINCT FROM approved_sum THEN
      RAISE EXCEPTION 'ck_statement_approved_total: an approved statement moves its contract''s approved total'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "contract_guard"() RETURNS trigger AS $$
DECLARE
  sides integer;
  effective_sum numeric;
  approved_sum numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."tender_id" IS DISTINCT FROM OLD."tender_id"
       OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
       OR NEW."winning_bid_id" IS DISTINCT FROM OLD."winning_bid_id"
       OR NEW."contractor_organization_id" IS DISTINCT FROM OLD."contractor_organization_id"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."matrix_digest" IS DISTINCT FROM OLD."matrix_digest"
       OR NEW."awarded_by" IS DISTINCT FROM OLD."awarded_by"
       OR NEW."awarded_at" IS DISTINCT FROM OLD."awarded_at"
       OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_contract_origin_immutable: what a contract was made from never changes'
        USING ERRCODE = 'check_violation';
    END IF;

    -- A cancelled or settled contract is history: nothing about it changes again.
    IF OLD."status" IN ('CANCELLED', 'SETTLED') THEN
      RAISE EXCEPTION 'ck_contract_final: a % contract never changes', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SIGNED', 'CANCELLED'))
              OR (OLD."status" = 'SIGNED' AND NEW."status" = 'COMPLETED')
              OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'SETTLED')) THEN
        RAISE EXCEPTION 'ck_contract_transition: a contract cannot move from % to %', OLD."status", NEW."status"
          USING ERRCODE = 'check_violation';
      END IF;
      -- Both parties have accepted, or the contract is not signed (Q-95 (1)).
      IF NEW."status" = 'SIGNED' THEN
        SELECT count(DISTINCT "side") INTO sides FROM "contract_signature"
         WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."id";
        IF sides <> 2 THEN
          RAISE EXCEPTION 'ck_contract_signed_by_both: a contract is signed only when both sides have signed'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;

    IF OLD."cancel_reason_code" IS NOT NULL
       AND (NEW."cancel_reason_code" IS DISTINCT FROM OLD."cancel_reason_code"
            OR NEW."cancel_note" IS DISTINCT FROM OLD."cancel_note") THEN
      RAISE EXCEPTION 'ck_contract_cancellation_immutable: the reason a contract was cancelled never changes'
        USING ERRCODE = 'check_violation';
    END IF;

    -- The amount counters (ADR-068 § 5). Each moves only on a contract that is and stays SIGNED,
    -- and only to the exact sum of what it counts — so only in the transaction that made an
    -- amendment effective or approved a statement.
    IF NEW."amendments_total_minor" IS DISTINCT FROM OLD."amendments_total_minor" THEN
      IF OLD."status" <> 'SIGNED' OR NEW."status" <> 'SIGNED' THEN
        RAISE EXCEPTION 'ck_contract_amendments_signed: only a signed contract is amended'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum("delta_minor"), 0) INTO effective_sum FROM "amendment"
       WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."id"
         AND "status" = 'EFFECTIVE';
      IF NEW."amendments_total_minor" <> effective_sum THEN
        RAISE EXCEPTION 'ck_contract_amendments_total_exact: the amendments total is the sum of the effective amendments'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."approved_total_minor" IS DISTINCT FROM OLD."approved_total_minor" THEN
      IF OLD."status" <> 'SIGNED' OR NEW."status" <> 'SIGNED' THEN
        RAISE EXCEPTION 'ck_contract_approved_signed: statements are approved on a signed contract'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum("gross_minor"), 0) INTO approved_sum FROM "statement"
       WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."id"
         AND "status" = 'APPROVED';
      IF NEW."approved_total_minor" <> approved_sum THEN
        RAISE EXCEPTION 'ck_contract_approved_total_exact: the approved total is the sum of the approved statements'' gross'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_contract_not_erasable: a contract is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017160000_statement_settlement';

COMMIT;
