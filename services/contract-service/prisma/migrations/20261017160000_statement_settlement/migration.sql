-- =============================================================================
-- contract-service — a statement settled on economic-service's confirmation, and the contract settled
-- when every approved statement is (CON-003 PR 6c, ADR-068 § 6 (3) and (5), docs/24 Q-97 (6)).
--
--   * `StatementStatus` gains SETTLED, and `statement` the settlement economic-service confirmed:
--     when it was settled (`settled_at`, economic's instant), the obligation and the settlement that
--     discharged it (`settlement_obligation_id`, `settlement_id`), the amount it took
--     (`settled_amount_minor`, which is the statement's net — Q-97 (4): no partial payment) and the
--     `SETTLEMENT_COMPLETED` event that triggered the confirmation (`settlement_event_id`). All five
--     exactly when SETTLED (`ck_statement_settlement`); one obligation settles one statement
--     (`ux_statement_settlement_obligation`).
--   * `statement_guard` opens APPROVED > SETTLED — on a contract SIGNED or COMPLETED — and nothing
--     else out of APPROVED (I3: an approved statement never changes except to SETTLED); SETTLED is
--     final, like REJECTED.
--   * `statement_decisions_consistent` takes a SETTLED statement for the APPROVED one its decisions
--     say, one change later; the approved total is the gross of the APPROVED and SETTLED statements.
--   * `contract_guard` lets a contract go COMPLETED > SETTLED only when none of its statements is open
--     (DRAFT, SUBMITTED, TECHNICALLY_APPROVED or APPROVED) and the sum settled is the sum of the
--     approved net (ADR-068 § 6 (3)); the approved total counts SETTLED statements too.
--
-- The enum value and the constraints that name it: PostgreSQL allows ADD VALUE inside a transaction,
-- but the new value cannot be *used* in it, so everything below names SETTLED through `::text`, which
-- names the value without resolving it (as 20261006100000_policy_suspension).
--
-- Every instant is TIMESTAMPTZ(3) (D-048).
--
--   statement transitions: DRAFT>SUBMITTED SUBMITTED>TECHNICALLY_APPROVED SUBMITTED>REJECTED TECHNICALLY_APPROVED>APPROVED TECHNICALLY_APPROVED>REJECTED APPROVED>SETTLED
-- =============================================================================

ALTER TYPE "StatementStatus" ADD VALUE 'SETTLED';

ALTER TABLE "statement"
  ADD COLUMN "settled_at" TIMESTAMPTZ(3),
  ADD COLUMN "settlement_obligation_id" TEXT,
  ADD COLUMN "settlement_id" TEXT,
  ADD COLUMN "settled_amount_minor" BIGINT,
  ADD COLUMN "settlement_event_id" TEXT;

-- Settled exactly when it carries the whole settlement economic confirmed, of exactly its net.
ALTER TABLE "statement" ADD CONSTRAINT "ck_statement_settlement"
  CHECK (num_nonnulls("settled_at", "settlement_obligation_id", "settlement_id",
                      "settled_amount_minor", "settlement_event_id") IN (0, 5)
         AND (("status"::text = 'SETTLED') = ("settled_at" IS NOT NULL))
         AND ("settled_amount_minor" IS NULL OR "settled_amount_minor" = "net_minor")
         AND ("settlement_obligation_id" IS NULL
              OR (btrim("settlement_obligation_id") <> '' AND btrim("settlement_id") <> ''
                  AND btrim("settlement_event_id") <> '')));

-- One obligation settles one statement.
CREATE UNIQUE INDEX "ux_statement_settlement_obligation" ON "statement"("organization_id", "settlement_obligation_id");

-- What the consumer looks for when economic-service reports a settlement: the payer's statements in
-- a status, of an amount.
CREATE INDEX "ix_statement_settleable" ON "statement"("organization_id", "status", "net_minor");

-- ---- statement_guard: APPROVED > SETTLED ------------------------------------------

-- As in 20261016180000, with the settlement: an APPROVED statement moves to SETTLED and to nothing
-- else, on a contract SIGNED or COMPLETED; SETTLED and REJECTED are final.
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
    IF OLD."status"::text IN ('REJECTED', 'SETTLED') THEN
      RAISE EXCEPTION 'ck_statement_final: a % statement never changes', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- I3 (ADR-068 § 6 (5)): an approved statement changes only to SETTLED.
    IF OLD."status" = 'APPROVED' AND NEW."status"::text <> 'SETTLED' THEN
      RAISE EXCEPTION 'ck_statement_final: an APPROVED statement changes only to SETTLED'
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
         'TECHNICALLY_APPROVED>APPROVED', 'TECHNICALLY_APPROVED>REJECTED', 'APPROVED>SETTLED']))
    THEN
      RAISE EXCEPTION 'ck_statement_transition: % to % is not a statement transition', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- Every change is a submission, a decision or the settlement, and each moves the version by one.
    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
      RAISE EXCEPTION 'ck_statement_version: every change of a statement moves its version by one'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "status" INTO parent_status FROM "contract"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."contract_id";
    IF OLD."status" = 'APPROVED' THEN
      -- The money of an approved statement is owed whatever the work's state: it is settled while the
      -- contract is SIGNED or once it is COMPLETED.
      IF parent_status IS DISTINCT FROM 'SIGNED' AND parent_status IS DISTINCT FROM 'COMPLETED' THEN
        RAISE EXCEPTION 'ck_statement_settled_contract: a statement is settled on a signed or completed contract'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF parent_status IS DISTINCT FROM 'SIGNED' THEN
      RAISE EXCEPTION 'ck_statement_contract_signed: a statement is submitted and decided on a signed contract'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_statement_not_erasable: a statement is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ---- the decisions, whole, at commit: SETTLED is APPROVED, one change later -----------------

-- As in 20261016180000: a decided statement's status is what its decisions say, its version its
-- submission's plus one per decision — and a SETTLED statement is the APPROVED one its decisions say,
-- one change (the settlement) later. The approved total is the gross of the APPROVED and the SETTLED
-- statements: settling one never takes it out of what was approved.
CREATE OR REPLACE FUNCTION "statement_decisions_consistent"() RETURNS trigger AS $$
DECLARE
  target text;
  recorded RECORD;
  technical_approved integer;
  financial_approved integer;
  rejected integer;
  decided integer;
  expected text;
  settled integer;
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
  IF recorded."status"::text = 'SETTLED' AND expected = 'APPROVED' THEN
    settled := 1;
  ELSE
    settled := 0;
  END IF;
  IF (recorded."status"::text <> expected AND settled = 0)
     OR recorded."version" <> 2 + decided + settled THEN
    RAISE EXCEPTION 'ck_statement_decisions_consistent: a statement''s status and version are what its decisions say'
      USING ERRCODE = 'check_violation';
  END IF;
  IF expected = 'APPROVED' THEN
    SELECT coalesce(sum("gross_minor"), 0) INTO approved_sum FROM "statement"
     WHERE "organization_id" = NEW."organization_id" AND "contract_id" = recorded."contract_id"
       AND "status"::text IN ('APPROVED', 'SETTLED');
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

-- ---- contract_guard: SETTLED only when every approved statement is ----------------------

-- As in 20261016180000, with the settlement rule of ADR-068 § 6 (3): COMPLETED > SETTLED only when no
-- statement of the contract is open — none DRAFT, SUBMITTED, TECHNICALLY_APPROVED or APPROVED — and
-- the sum economic settled is the sum of the approved net. The approved total counts the SETTLED
-- statements as well as the APPROVED ones.
CREATE OR REPLACE FUNCTION "contract_guard"() RETURNS trigger AS $$
DECLARE
  sides integer;
  effective_sum numeric;
  approved_sum numeric;
  open_statements integer;
  approved_net numeric;
  settled_net numeric;
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
      -- ADR-068 § 6 (3): settled when no statement is open and Σ settled = Σ approved net.
      IF NEW."status" = 'SETTLED' THEN
        SELECT count(*) FILTER (WHERE "status"::text IN ('DRAFT', 'SUBMITTED', 'TECHNICALLY_APPROVED', 'APPROVED')),
               coalesce(sum("net_minor") FILTER (WHERE "status"::text IN ('APPROVED', 'SETTLED')), 0),
               coalesce(sum("settled_amount_minor") FILTER (WHERE "status"::text = 'SETTLED'), 0)
          INTO open_statements, approved_net, settled_net
          FROM "statement"
         WHERE "organization_id" = NEW."organization_id" AND "contract_id" = NEW."id";
        IF open_statements > 0 OR approved_net <> settled_net THEN
          RAISE EXCEPTION 'ck_contract_settled_in_full: a contract is settled only when no statement is open and every approved statement is settled in full'
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
         AND "status"::text IN ('APPROVED', 'SETTLED');
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
