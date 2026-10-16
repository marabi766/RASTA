-- =============================================================================
-- contract-service — the decisions of a statement's two approval chains (CON-003 PR 6, ADR-068 § 5,
-- docs/24 Q-96 (2), (3), (5) and (7), Q-135).
--
--   * `statement_decision` — one row per decided step of a submitted statement's snapshot
--     (`statement_approval_step`): APPROVED or REJECTED, by whom (the user id and the token's
--     verified issuer and subject, all three required), for which organization and under which
--     role. Insert-only. The step must be the next undecided one of the chain that is open — the
--     technical chain while the statement is SUBMITTED, the financial one only once it is
--     TECHNICALLY_APPROVED (Q-96 (2)) — and the decider must be the step's authority. Separation of
--     duties (Q-96 (3)): a person decides at most once per statement, across both chains — two
--     unique indexes (the stable identity, the user id) — and never the person who submitted it.
--   * `statement_guard` opens the decisions' transitions: SUBMITTED > TECHNICALLY_APPROVED (the last
--     technical step approved), TECHNICALLY_APPROVED > APPROVED (the last financial step approved),
--     SUBMITTED > REJECTED and TECHNICALLY_APPROVED > REJECTED (any step rejected: final for that
--     number, Q-96 (7)); a decision that completes nothing moves the version alone. An APPROVED or
--     REJECTED statement never changes again.
--   * At commit (`statement_decisions_consistent`) a decided statement's status is exactly what its
--     decisions say, its version counts them, and an APPROVED one has moved the contract's approved
--     total in the same transaction.
--   * `contract_guard` lets `approved_total_minor` move — on a SIGNED contract, and only to the exact
--     sum of the gross of its APPROVED statements. `ck_contract_approved_cap` (20261007100000) is the
--     cap: Σ gross(APPROVED) ≤ amount + Σ amendments (Q-96 (5)).
--
-- No timer and no default: a step waits until its authority decides (ADR-043). Every instant is
-- TIMESTAMPTZ(3) (D-048).
--
--   statement transitions: DRAFT>SUBMITTED SUBMITTED>TECHNICALLY_APPROVED SUBMITTED>REJECTED TECHNICALLY_APPROVED>APPROVED TECHNICALLY_APPROVED>REJECTED
-- =============================================================================

-- ---- statement_decision -------------------------------------------------------

-- CreateTable
CREATE TABLE "statement_decision" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "decider_organization_id" TEXT NOT NULL,
    "decider_role" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "decided_by_issuer" TEXT NOT NULL,
    "decided_by_subject" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "statement_decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One decision per step of the snapshot.
CREATE UNIQUE INDEX "ux_statement_decision_step" ON "statement_decision"("organization_id", "statement_id", "chain", "step_order");
-- One decision per person per statement, across both chains (Q-96 (3)): by stable identity, and by
-- user id.
CREATE UNIQUE INDEX "ux_statement_decision_person" ON "statement_decision"("organization_id", "statement_id", "decided_by_issuer", "decided_by_subject");
CREATE UNIQUE INDEX "ux_statement_decision_user" ON "statement_decision"("organization_id", "statement_id", "decided_by");

-- AddForeignKey
-- A decision is of a step of the statement's snapshot, and so of the statement.
ALTER TABLE "statement_decision" ADD CONSTRAINT "statement_decision_step_fkey"
  FOREIGN KEY ("organization_id", "statement_id", "chain", "step_order")
  REFERENCES "statement_approval_step"("organization_id", "statement_id", "chain", "step_order")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "statement_decision" ADD CONSTRAINT "statement_decision_organization_id_statement_id_fkey"
  FOREIGN KEY ("organization_id", "statement_id") REFERENCES "statement"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "statement_decision" ADD CONSTRAINT "ck_statement_decision_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("contract_id") <> ''
         AND btrim("statement_id") <> '' AND btrim("decider_organization_id") <> ''
         AND btrim("decider_role") <> '' AND btrim("decided_by") <> ''
         AND btrim("decided_by_issuer") <> '' AND btrim("decided_by_subject") <> ''
         AND btrim("correlation_id") <> '');

ALTER TABLE "statement_decision" ADD CONSTRAINT "ck_statement_decision_terms"
  CHECK ("chain" IN ('TECHNICAL', 'FINANCIAL') AND "step_order" >= 1
         AND "outcome" IN ('APPROVED', 'REJECTED')
         AND "decider_role" NOT IN ('AUDITOR', 'SYSTEM_ADMIN'));

-- A decision is written once, in the transaction that records it, for the next undecided step of the
-- chain that is open, by that step's authority, by a person other than the submitter and other than
-- anyone who decided this statement before; it is never changed or removed.
CREATE FUNCTION "statement_decision_guard"() RETURNS trigger AS $$
DECLARE
  parent RECORD;
  step RECORD;
  next_step integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "contract_id", "status", "submitted_at", "submitted_by", "submitted_by_issuer",
           "submitted_by_subject" INTO parent FROM "statement"
     WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."statement_id";
    IF NOT FOUND OR parent."contract_id" <> NEW."contract_id"
       OR NEW."decided_at" < parent."submitted_at" THEN
      RAISE EXCEPTION 'ck_statement_decision_statement: a decision is of a submitted statement of this contract'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Technical first; the financial chain opens only once the technical one is done (Q-96 (2)).
    IF NOT ((NEW."chain" = 'TECHNICAL' AND parent."status" = 'SUBMITTED')
            OR (NEW."chain" = 'FINANCIAL' AND parent."status" = 'TECHNICALLY_APPROVED')) THEN
      RAISE EXCEPTION 'ck_statement_decision_chain_open: a decision is of the chain that is open'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT min(s."step_order") INTO next_step FROM "statement_approval_step" s
     WHERE s."organization_id" = NEW."organization_id" AND s."statement_id" = NEW."statement_id"
       AND s."chain" = NEW."chain"
       AND NOT EXISTS (
         SELECT 1 FROM "statement_decision" d
          WHERE d."organization_id" = s."organization_id" AND d."statement_id" = s."statement_id"
            AND d."chain" = s."chain" AND d."step_order" = s."step_order");
    IF next_step IS DISTINCT FROM NEW."step_order" THEN
      RAISE EXCEPTION 'ck_statement_decision_in_order: a chain''s steps are decided in their order'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "authority_organization_id", "authority_role" INTO step FROM "statement_approval_step"
     WHERE "organization_id" = NEW."organization_id" AND "statement_id" = NEW."statement_id"
       AND "chain" = NEW."chain" AND "step_order" = NEW."step_order";
    IF step."authority_organization_id" <> NEW."decider_organization_id"
       OR step."authority_role" <> NEW."decider_role" THEN
      RAISE EXCEPTION 'ck_statement_decision_authority: a step is decided by its authority'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Never the submitter: by user id, by stable identity, or a user id that is the other's subject.
    IF NEW."decided_by" = parent."submitted_by"
       OR (NEW."decided_by_issuer" = parent."submitted_by_issuer"
           AND NEW."decided_by_subject" = parent."submitted_by_subject")
       OR NEW."decided_by" = parent."submitted_by_subject"
       OR NEW."decided_by_subject" = parent."submitted_by" THEN
      RAISE EXCEPTION 'ck_statement_decision_not_submitter: the person who submitted a statement never decides it'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Once per statement: the unique indexes hold the same identity and the same user id; this holds
    -- a user id that is another decision's subject.
    IF EXISTS (
      SELECT 1 FROM "statement_decision" d
       WHERE d."organization_id" = NEW."organization_id" AND d."statement_id" = NEW."statement_id"
         AND (d."decided_by" = NEW."decided_by_subject" OR d."decided_by_subject" = NEW."decided_by")
    ) THEN
      RAISE EXCEPTION 'ck_statement_decision_person_once: a person decides a statement at most once'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_statement_decision_immutable: a decision is never changed, deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_statement_decision_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "statement_decision"
  FOR EACH ROW EXECUTE FUNCTION "statement_decision_guard"();

CREATE TRIGGER "tg_statement_decision_no_truncate"
  BEFORE TRUNCATE ON "statement_decision"
  FOR EACH STATEMENT EXECUTE FUNCTION "statement_decision_guard"();

-- ---- statement_guard: the decisions' transitions ---------------------------------

-- As in 20261016120000, with the decisions: the transitions `statement.state-machine.ts` declares
-- (the header lists the same), each on a contract still SIGNED; a decision that completes nothing
-- keeps the status and moves the version; an APPROVED or REJECTED statement is final.
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

-- ---- the decisions, whole, at commit ----------------------------------------------

-- A decided statement's status is exactly what its decisions say — any rejection: REJECTED; every
-- financial step approved: APPROVED; every technical step approved: TECHNICALLY_APPROVED; else
-- SUBMITTED — and its version is its submission's plus one per decision, so no decision is written
-- without its statement's update and no update moves a statement without a decision. An APPROVED
-- statement has moved its contract's approved total: the total is the sum of the approved gross.
CREATE FUNCTION "statement_decisions_consistent"() RETURNS trigger AS $$
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

CREATE CONSTRAINT TRIGGER "tg_statement_decisions_consistent"
  AFTER UPDATE ON "statement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."status" <> 'DRAFT')
  EXECUTE FUNCTION "statement_decisions_consistent"();

CREATE CONSTRAINT TRIGGER "tg_statement_decision_consistent"
  AFTER INSERT ON "statement_decision"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "statement_decisions_consistent"();

-- ---- contract_guard: the approved total, kept by the database ---------------------

-- As in 20261007100000, with the approved total open: it moves on a contract that is and stays
-- SIGNED, and only to the exact sum of the gross of the contract's APPROVED statements — so only in
-- the transaction that approved one. `ck_contract_approved_cap` keeps it within the price and the
-- effective amendments.
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
