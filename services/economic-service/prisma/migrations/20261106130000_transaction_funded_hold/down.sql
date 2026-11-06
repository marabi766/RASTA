-- Reverse of `migration.sql` (20261106130000_transaction_funded_hold).
--
-- Gives 20261106120000's four bodies back, byte for byte, and drops the rest. `held_at` goes with
-- them: it is derived, and nothing but this migration's functions reads it. Roll the release back
-- first: its `WalletRepository.isHoldFunded` asks a function that goes here.
BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "wallet_hold", "transaction" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION transaction_own_hold_for_terms(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "transaction" t, transaction_holds(t."id", t."organization_id") h
     WHERE t."id" = subject
       AND h."status" = 'ACTIVE'
       AND h."amount_minor" = t."gross_amount_minor"
       AND h."currency" = t."currency");
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION transaction_settlement_barred(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "transaction_hold_reconciliation" c
     WHERE c."transaction_id" = subject
       AND c."outcome" <> 'RESTORED_TO_PENDING_SETTLEMENT'
       AND (transaction_hold_decision_unresolved(subject)
            OR NOT transaction_own_hold_for_terms(subject)));
$$ LANGUAGE sql STABLE;

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

DROP TRIGGER "trg_wallet_hold_resolved_only_funded" ON "wallet_hold";
DROP FUNCTION enforce_wallet_hold_resolved_only_funded();
DROP FUNCTION wallet_hold_funded(TEXT);
DROP INDEX "wallet_hold_placed_journal_id_idx";
DROP TRIGGER "trg_transaction_held_at" ON "transaction";
DROP FUNCTION stamp_transaction_held_at();
ALTER TABLE "transaction" DROP COLUMN "held_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106130000_transaction_funded_hold';

COMMIT;
