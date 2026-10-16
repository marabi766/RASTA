-- =============================================================================
-- Reverse of `migration.sql` (20261016180000_statement_decisions, CON-003 PR 6).
--
-- Drops the decisions and their commit check, and restores the previous `statement_guard` (only
-- DRAFT > SUBMITTED open) and `contract_guard` (the approved total fixed). Roll the code back first:
-- it records decisions and moves the approved total.
--
-- **Refuses, and changes nothing, once any of this has been used.** A decision is the record of an
-- approver's judgement, a decided statement the outcome of the chains, and an approved total what a
-- settlement may already rest on; dropping any of it would leave a record no schema explains. So
-- this script stops, with a message, when any decision exists, any statement is past SUBMITTED, or
-- any contract's approved total is not 0. On a database where none of it was used — submitted
-- statements and their chains all stay — it restores the previous schema exactly.
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check that RAISEs and every change commit
-- together or not at all. The `_prisma_migrations` row is removed last so the forward migration can
-- be re-applied.
-- =============================================================================

BEGIN;

-- Locked first, so nothing can be written between the check and the changes.
LOCK TABLE "statement_decision", "statement", "contract" IN ACCESS EXCLUSIVE MODE;

DO $preflight_statement_decisions$
DECLARE
  decisions integer;
  decided integer;
  approved_totals integer;
BEGIN
  SELECT count(*) INTO decisions FROM "statement_decision";
  SELECT count(*) INTO decided FROM "statement"
   WHERE "status" IN ('TECHNICALLY_APPROVED', 'APPROVED', 'REJECTED');
  SELECT count(*) INTO approved_totals FROM "contract" WHERE "approved_total_minor" <> 0;
  IF decisions > 0 OR decided > 0 OR approved_totals > 0 THEN
    RAISE EXCEPTION 'down refused: % statement decision(s), % decided statement(s) and % contract(s) with an approved total exist; nothing was changed', decisions, decided, approved_totals
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_statement_decisions$;

-- ---- the decisions and the commit check ---------------------------------------------

DROP TRIGGER IF EXISTS "tg_statement_decision_consistent" ON "statement_decision";
DROP TRIGGER IF EXISTS "tg_statement_decisions_consistent" ON "statement";
DROP FUNCTION IF EXISTS "statement_decisions_consistent"();

DROP TRIGGER IF EXISTS "tg_statement_decision_no_truncate" ON "statement_decision";
DROP TRIGGER IF EXISTS "tg_statement_decision_guard" ON "statement_decision";
DROP TABLE IF EXISTS "statement_decision";
DROP FUNCTION IF EXISTS "statement_decision_guard"();

-- ---- statement_guard, as 20261016120000 wrote it ---------------------------------------

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

-- ---- contract_guard, as 20261007100000 wrote it ----------------------------------------

CREATE OR REPLACE FUNCTION "contract_guard"() RETURNS trigger AS $$
DECLARE
  sides integer;
  effective_sum numeric;
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

    -- The amount counters (ADR-068 § 5). The amendments total moves only on a contract that is
    -- and stays SIGNED, and only to the exact sum of the effective amendments — so only in the
    -- transaction that made one effective. The approved total is PR 4's: it stays where it is.
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
      RAISE EXCEPTION 'ck_contract_approved_total_fixed: the approved total moves with statements, which do not exist yet'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_contract_not_erasable: a contract is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016180000_statement_decisions';

COMMIT;
