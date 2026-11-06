-- A decision read from a hold not its own proves nothing until a person has decided it
-- (FU-138; #762 r3, F2).
--
-- 20261105120000 listed the rows that stand on such a decision in
-- `transaction_hold_reconciliation`, and nothing read the list: a row HELD with no hold of its
-- own still read as escrow to the order saga, which recorded FUNDS_HELD and published
-- ORDER_FUNDS_HELD; a backfilled authorisation from another's hold still released a hold.
--
-- ## One interpretation
--
-- `transaction_hold_decision_unresolved(id)`: the row is listed, under any outcome but
-- RESTORED_TO_PENDING_SETTLEMENT (the only one the list's migration proved), and no decision
-- is recorded for it. Named by exclusion, so an outcome nobody thought of here is unresolved.
-- Everything below asks it; nothing else reads the list:
--
--   - `transaction_settlement_authorised(id, column_set)`: an unresolved row is authorised by
--     nothing, its `settlement_authorised_at` included; a voided one no longer by the frozen
--     AUTHORISED_UNRECORDED record. The service's lock read and the three predicates ask this.
--   - `transaction_settlement_barred(id)`: payment, apart from the evidence (D-123). A listed row,
--     but for RESTORED_TO_PENDING_SETTLEMENT, pays only from its own ACTIVE hold for exactly its
--     gross and currency, and only once decided. A decision disposes of the evidence and authorises
--     no payment, so nothing held never means the payer's spendable balance. The service's lock
--     read, the settlement and release triggers and where a resolved dispute returns all ask this.
--   - `transaction_held_proven(id)`: what HELD says, proven: HELD, resolved, and the payer's own
--     ACTIVE hold for exactly the gross and currency. Not "not listed": a HELD row no hold names
--     at all was never listed, and is not escrow either. The API answers it as `heldProven`.
--
-- A refund stays open on purpose: it only ever gives the payer's own hold back to the payer, and
-- it is a way out for a row a person will not decide. With nothing held it moves no money.
--
-- ## The decision
--
-- `decide_transaction_hold(id, decision, reason)`, the migrator's, as
-- `quarantine_transaction_source` is (docs/runbooks/transaction-hold-decision.md). Under the
-- row lock settlement takes first; one decision per row, append-only, with who and why:
--
--   - CONFIRMED: what the row stands on is right. A HELD row, or one found HELD and still open
--     (an authorisation or a dispute can move it on while it waits), needs its own ACTIVE hold for
--     exactly its terms: nothing can be confirmed as held that is not.
--   - VOIDED: it is not. A frozen AUTHORISED_UNRECORDED stops counting, and the row stays where it
--     stands, barred (D-123). Refused on a HELD row with a hold of its own: then HELD is true, and a
--     refund or CONFIRMED is the answer. Its ways on: its own hold for its terms, proven and
--     authorised like any row's, or a refund.
--
-- `trg_transaction_hold_decision_guard` refuses a write by anyone but the table's owner: the
-- runtime role's default privileges include INSERT, and it must not decide its own refusals.
--
-- Concurrency: every reader is fail-closed against a decision in flight, since a decision only
-- ever arrives once and an old snapshot reads "unresolved".
SET LOCAL lock_timeout = '3s';

CREATE TABLE "transaction_hold_decision" (
    "transaction_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_hold_decision_pkey" PRIMARY KEY ("transaction_id"),
    CONSTRAINT "transaction_hold_decision_transaction_id_fkey" FOREIGN KEY ("transaction_id")
        REFERENCES "transaction_hold_reconciliation"("transaction_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ck_transaction_hold_decision_decision"
        CHECK ("decision" IN ('CONFIRMED', 'VOIDED')),
    CONSTRAINT "ck_transaction_hold_decision_reason"
        CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500)
);

CREATE OR REPLACE FUNCTION guard_transaction_hold_decision() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'transaction_hold_decision is append-only: a decision is never changed'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_transaction_hold_decision_guard';
  END IF;
  IF current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION 'A hold decision is an operator''s: decide_transaction_hold, as the migrator'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'trg_transaction_hold_decision_guard';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_transaction_hold_decision_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "transaction_hold_decision"
  FOR EACH ROW EXECUTE FUNCTION guard_transaction_hold_decision();

CREATE TRIGGER "trg_transaction_hold_decision_no_truncate"
  BEFORE TRUNCATE ON "transaction_hold_decision"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_transaction_hold_decision();

-- The one interpretation of the evidence.
CREATE OR REPLACE FUNCTION transaction_hold_decision_unresolved(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "transaction_hold_reconciliation" c
     WHERE c."transaction_id" = subject
       AND c."outcome" <> 'RESTORED_TO_PENDING_SETTLEMENT'
       AND NOT EXISTS (SELECT 1 FROM "transaction_hold_decision" d
                        WHERE d."transaction_id" = c."transaction_id"));
$$ LANGUAGE sql STABLE;

-- The payer's own ACTIVE hold for exactly the transaction's gross and currency.
CREATE OR REPLACE FUNCTION transaction_own_hold_for_terms(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "transaction" t, transaction_holds(t."id", t."organization_id") h
     WHERE t."id" = subject
       AND h."status" = 'ACTIVE'
       AND h."amount_minor" = t."gross_amount_minor"
       AND h."currency" = t."currency");
$$ LANGUAGE sql STABLE;

-- The one interpretation of payment (D-123). Named by exclusion, as the evidence's is. RESTORED is
-- not barred: no decision stands behind it, the list's migration proved it.
CREATE OR REPLACE FUNCTION transaction_settlement_barred(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "transaction_hold_reconciliation" c
     WHERE c."transaction_id" = subject
       AND c."outcome" <> 'RESTORED_TO_PENDING_SETTLEMENT'
       AND (transaction_hold_decision_unresolved(subject)
            OR NOT transaction_own_hold_for_terms(subject)));
$$ LANGUAGE sql STABLE;

-- `column_set`: the caller's `settlement_authorised_at IS NOT NULL`, of the row as it holds it.
CREATE OR REPLACE FUNCTION transaction_settlement_authorised(subject TEXT, column_set BOOLEAN)
RETURNS BOOLEAN AS $$
  SELECT NOT transaction_hold_decision_unresolved(subject)
     AND (column_set
          OR (EXISTS (SELECT 1 FROM "settlement_authority_reconciliation" r
                       WHERE r."transaction_id" = subject AND r."outcome" = 'AUTHORISED_UNRECORDED')
              AND NOT EXISTS (SELECT 1 FROM "transaction_hold_decision" d
                               WHERE d."transaction_id" = subject AND d."decision" = 'VOIDED')));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION transaction_held_proven(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "transaction" t
     WHERE t."id" = subject
       AND t."status" = 'HELD'
       AND NOT transaction_hold_decision_unresolved(t."id")
       AND transaction_own_hold_for_terms(t."id"));
$$ LANGUAGE sql STABLE;

-- The triggers run as the writer, and PUBLIC has no EXECUTE on what the migrator creates.
-- infrastructure/docker/postgres/lib/runtime-function-grants.txt names the same five.
GRANT EXECUTE ON FUNCTION transaction_hold_decision_unresolved(TEXT) TO rasta_economic;
GRANT EXECUTE ON FUNCTION transaction_own_hold_for_terms(TEXT) TO rasta_economic;
GRANT EXECUTE ON FUNCTION transaction_settlement_barred(TEXT) TO rasta_economic;
GRANT EXECUTE ON FUNCTION transaction_settlement_authorised(TEXT, BOOLEAN) TO rasta_economic;
GRANT EXECUTE ON FUNCTION transaction_held_proven(TEXT) TO rasta_economic;

-- 20261105120000's three bodies, each authority predicate asking the one answer above.
CREATE OR REPLACE FUNCTION enforce_transaction_settlement_authority() RETURNS TRIGGER AS $$
BEGIN
  IF transaction_hold_decision_unresolved(OLD."id") THEN
    RAISE EXCEPTION 'A transaction standing on an unresolved hold decision settles only once an operator has decided it'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_transaction_settlement_authority';
  END IF;
  -- settle() has by now released the hold it pays from (the release asked this with it ACTIVE),
  -- by the journal of the settlement it wrote. No other RELEASED hold speaks for this one.
  IF transaction_settlement_barred(OLD."id")
     AND NOT EXISTS (
       SELECT 1 FROM transaction_holds(OLD."id", OLD."organization_id") h
         JOIN "settlement" s ON s."transaction_id" = OLD."id" AND s."journal_id" = h."resolved_journal_id"
        WHERE h."status" = 'RELEASED'
          AND h."amount_minor" = OLD."gross_amount_minor"
          AND h."currency" = OLD."currency") THEN
    RAISE EXCEPTION 'A decision on a hold record authorises no payment: this transaction settles only from its own hold'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_transaction_settlement_authority';
  END IF;
  IF NOT transaction_settlement_authorised(OLD."id", OLD."settlement_authorised_at" IS NOT NULL)
     AND EXISTS (SELECT 1 FROM transaction_holds(OLD."id", OLD."organization_id")) THEN
    -- Fixed words: no identifier or amount in the message the service logs.
    RAISE EXCEPTION 'A transaction whose funds were held settles only once its settlement is authorised'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_transaction_settlement_authority';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_hold_release_settlement_authority() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "transaction" t, transaction_holds(t."id", t."organization_id") h
     WHERE t."id" = OLD."reference"
       AND h."id" = OLD."id"
       AND transaction_settlement_authorised(t."id", t."settlement_authorised_at" IS NOT NULL)
       AND NOT transaction_settlement_barred(t."id")
  ) THEN
    RAISE EXCEPTION 'Escrowed funds are released to the payee only once settlement is authorised'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_wallet_hold_release_settlement_authority';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_transaction_dispute_resolution() RETURNS TRIGGER AS $$
DECLARE
  supported TEXT;
BEGIN
  IF OLD."status" <> 'DISPUTED' OR NEW."status" NOT IN ('PENDING_SETTLEMENT', 'HELD') THEN
    RETURN NEW;
  END IF;
  IF transaction_settlement_barred(OLD."id") THEN
    supported := 'HELD';
  ELSIF transaction_settlement_authorised(OLD."id", OLD."settlement_authorised_at" IS NOT NULL) THEN
    supported := 'PENDING_SETTLEMENT';
  ELSIF EXISTS (SELECT 1 FROM transaction_holds(OLD."id", OLD."organization_id") h
                 WHERE h."status" = 'ACTIVE') THEN
    supported := 'HELD';
  ELSE
    supported := 'PENDING_SETTLEMENT';
  END IF;
  IF NEW."status"::TEXT <> supported THEN
    RAISE EXCEPTION 'A resolved dispute returns a transaction to where its settlement authority stands'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_transaction_dispute_resolution';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- The operator's tool. Fixed words but the id, as `quarantine_transaction_source`: only the
-- operator running it reads them.
CREATE OR REPLACE FUNCTION decide_transaction_hold(p_transaction_id TEXT, p_decision TEXT, p_reason TEXT)
RETURNS TEXT AS $$
DECLARE
  subject RECORD;
  outcome TEXT;
  own_hold BOOLEAN;
BEGIN
  SELECT t."id", t."status"::text AS status, t."organization_id"
    INTO subject
    FROM "transaction" t
   WHERE t."id" = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction %: no such transaction', p_transaction_id
      USING ERRCODE = 'no_data_found';
  END IF;
  SELECT c."outcome" INTO outcome
    FROM "transaction_hold_reconciliation" c
   WHERE c."transaction_id" = subject."id";
  IF outcome IS NULL OR outcome = 'RESTORED_TO_PENDING_SETTLEMENT' THEN
    RAISE EXCEPTION 'transaction %: has no unresolved hold decision to decide', subject."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Not by its status alone: authorised or disputed since, a row found HELD is not HELD now.
  IF p_decision = 'CONFIRMED'
     AND (subject.status = 'HELD'
          OR (outcome IN ('HELD_UNPROVEN', 'RETURNED_TO_HELD_UNPROVEN')
              AND subject.status NOT IN ('SETTLED', 'PARTIALLY_REVERSED', 'REVERSED',
                                         'REFUNDED', 'CANCELLED', 'FAILED')))
     AND NOT transaction_own_hold_for_terms(subject."id") THEN
    RAISE EXCEPTION 'transaction %: HELD is confirmed only by its own active hold for its amount and currency; VOIDED says nothing is held', subject."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF subject.status = 'HELD' THEN
    own_hold := EXISTS (SELECT 1 FROM transaction_holds(subject."id", subject."organization_id") h
                         WHERE h."status" = 'ACTIVE');
    IF p_decision = 'VOIDED' AND own_hold THEN
      RAISE EXCEPTION 'transaction %: VOIDED says nothing is held, and it has an active hold of its own: refund it, or CONFIRMED', subject."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The primary key refuses a second decision; the checks refuse an unknown word or an empty reason.
  INSERT INTO "transaction_hold_decision" ("transaction_id", "decision", "reason", "decided_by")
  VALUES (subject."id", p_decision, btrim(p_reason), session_user);

  -- The evidence only: no decision moves the row or authorises anything (D-123).
  RETURN subject.status;
END; $$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION decide_transaction_hold(TEXT, TEXT, TEXT) FROM PUBLIC;
