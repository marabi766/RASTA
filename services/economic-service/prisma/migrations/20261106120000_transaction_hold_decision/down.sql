-- Reverse of `migration.sql` (20261106120000_transaction_hold_decision).
--
-- Gives 20261105120000's three predicates back, byte for byte, and drops the rest. Refuses while
-- any decision is recorded: it is the only record of who decided what and why. Roll the release back first: this one's
-- `TransactionRepository.lockForUpdate` and `heldProven` ask the functions that go here.
BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "transaction_hold_decision" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE decided BIGINT;
BEGIN
  SELECT count(*) INTO decided FROM "transaction_hold_decision";
  IF decided > 0 THEN
    RAISE EXCEPTION 'transaction_hold_decision holds % row(s); refusing to drop the decisions they record', decided
      USING HINT = 'Each is the only record of who decided that row, and why.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_transaction_settlement_authority() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."settlement_authorised_at" IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "settlement_authority_reconciliation" r
        WHERE r."transaction_id" = OLD."id" AND r."outcome" = 'AUTHORISED_UNRECORDED')
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
       AND (t."settlement_authorised_at" IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM "settlement_authority_reconciliation" r
               WHERE r."transaction_id" = t."id" AND r."outcome" = 'AUTHORISED_UNRECORDED'))
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
  IF OLD."settlement_authorised_at" IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM "settlement_authority_reconciliation" r
        WHERE r."transaction_id" = OLD."id" AND r."outcome" = 'AUTHORISED_UNRECORDED') THEN
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

DROP FUNCTION decide_transaction_hold(TEXT, TEXT, TEXT);
DROP FUNCTION transaction_held_proven(TEXT);
DROP FUNCTION transaction_settlement_barred(TEXT);
DROP FUNCTION transaction_own_hold_for_terms(TEXT);
DROP FUNCTION transaction_settlement_authorised(TEXT, BOOLEAN);
DROP FUNCTION transaction_hold_decision_unresolved(TEXT);
DROP TABLE "transaction_hold_decision";
DROP FUNCTION guard_transaction_hold_decision();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106120000_transaction_hold_decision';

COMMIT;
