-- Reverse of `migration.sql` (20261109120000_guards_read_committed).
--
-- Gives back, byte for byte, the bodies of 20261016120000 (the pricing scope lock), 20261105120000
-- (the hold reference and the transaction id), 20261107120000 (the hold journal guards) and
-- 20261108120000 (the wallet and escrow accounts), which take their locks themselves, then drops
-- the commission rule gate, the note trigger, their functions, the leg predicate and the gate.
-- Nothing was rewritten going up, so nothing is put back. The service calls the gate itself
-- (`lockReadCommitted`, `lockScopeForChange`): roll the release back first, or a rule change and a
-- reward, participation or recognition rule write is refused (fails closed) until it is.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION commission_pricing_scope_lock(
  organization_id TEXT, business_line "BusinessLine", transaction_type "TransactionType"
) RETURNS VOID AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(commission_rule_scope_key(NULL, business_line, transaction_type));
  PERFORM pg_advisory_xact_lock_shared(commission_rule_scope_key(organization_id, business_line, transaction_type));
END; $$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION enforce_wallet_hold_reference() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A hold is never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_wallet_hold_reference_bound';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD."id", OLD."organization_id", OLD."wallet_id", OLD."reference", OLD."reference_type")
       IS DISTINCT FROM
       (NEW."id", NEW."organization_id", NEW."wallet_id", NEW."reference", NEW."reference_type") THEN
      RAISE EXCEPTION 'Whose a hold is and what it is for never changes'
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_wallet_hold_reference_bound';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "wallet" w
                  WHERE w."id" = NEW."wallet_id" AND w."organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'A hold is on a wallet of its own organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_hold_reference_bound';
  END IF;
  IF NEW."reference_type" = 'TRANSACTION' THEN
    IF NOT EXISTS (SELECT 1 FROM "transaction" t
                    WHERE t."id" = NEW."reference" AND t."organization_id" = NEW."organization_id") THEN
      RAISE EXCEPTION 'A hold for a transaction names a transaction of its own organization'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_hold_reference_bound';
    END IF;
  ELSE
    -- Then the read: taken from here, a transaction inserted first has committed, or waits.
    PERFORM pg_advisory_xact_lock(20261105, hashtext(NEW."reference"));
    IF EXISTS (SELECT 1 FROM "transaction" t WHERE t."id" = NEW."reference") THEN
      RAISE EXCEPTION 'A hold for anything else names no transaction'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_hold_reference_bound';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_transaction_id_unclaimed() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20261105, hashtext(NEW."id"));
  IF EXISTS (SELECT 1 FROM "wallet_hold" h WHERE h."reference" = NEW."id") THEN
    RAISE EXCEPTION 'A transaction takes no id a hold has already named'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_transaction_id_unclaimed';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_wallet_hold_funded_at_commit() RETURNS TRIGGER AS $$
DECLARE pointer TEXT;
BEGIN
  -- The row as it stands at commit, not as this event saw it: a later write may have resolved it.
  SELECT h."placed_journal_id" INTO pointer FROM "wallet_hold" h
   WHERE h."id" = NEW."id" AND (h."placed_journal_id" IS NOT NULL OR h."status" <> 'ACTIVE');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF pointer IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wallet_hold_journal:' || pointer, 0));
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'A hold naming a journal is written only under READ COMMITTED'
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_wallet_hold_funded_at_commit';
    END IF;
  END IF;
  IF NOT wallet_hold_funded(NEW."id") THEN
    RAISE EXCEPTION 'At commit, a hold that names a journal or is resolved is funded by it: the payer''s own wallet into its own escrow'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_hold_funded_at_commit';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_hold_journal_reversal() RETURNS TRIGGER AS $$
BEGIN
  -- Only a FUNDS_HELD journal funds a hold (`wallet_hold_funded`); the lock is the one above.
  IF EXISTS (SELECT 1 FROM "journal" j WHERE j."id" = NEW."reverses_id" AND j."journal_type" = 'FUNDS_HELD') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wallet_hold_journal:' || NEW."reverses_id", 0));
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'A FUNDS_HELD journal is reversed only under READ COMMITTED'
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_journal_hold_funding_final';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "wallet_hold" h WHERE h."placed_journal_id" = NEW."reverses_id") THEN
    RAISE EXCEPTION 'A journal a hold names is never reversed: the hold goes back by its refund'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_journal_hold_funding_final';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_wallet_account_covered() RETURNS TRIGGER AS $$
DECLARE balance NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ledger_account" a
                  WHERE a."id" = NEW."account_id" AND a."purpose" IN ('WALLET', 'ESCROW')) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wallet_account_covered:' || NEW."account_id", 0));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'A wallet or escrow account is debited only under READ COMMITTED'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_ledger_entry_wallet_covered';
  END IF;
  -- A new statement, so under READ COMMITTED a new snapshot: it sees what committed during the wait.
  -- At least this leg is there; a sum that is not a number is refused all the same.
  SELECT SUM(CASE e."direction" WHEN 'CREDIT' THEN e."amount_minor" ELSE -e."amount_minor" END)
    INTO balance FROM "ledger_entry" e WHERE e."account_id" = NEW."account_id";
  IF balance IS NULL OR balance < 0 THEN
    RAISE EXCEPTION 'At commit, a wallet or escrow account never sums below zero'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_ledger_entry_wallet_covered';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER "trg_commission_rule_read_committed" ON "commission_rule";
DROP FUNCTION enforce_commission_rule_read_committed();
DROP TRIGGER "trg_ledger_entry_wallet_debits_noted" ON "ledger_entry";
DROP FUNCTION note_wallet_account_debits();
DROP FUNCTION wallet_account_debited_later(TEXT);
DROP FUNCTION read_committed_xact_lock(BIGINT, TEXT, TEXT);
DROP FUNCTION read_committed_xact_lock(INTEGER, INTEGER, TEXT, TEXT);
DROP FUNCTION read_committed_xact_lock_shared(BIGINT, TEXT, TEXT);

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109120000_guards_read_committed';

COMMIT;
