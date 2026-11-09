-- Reverse of `migration.sql` (20261109120000_guards_read_committed).
--
-- Gives back, byte for byte, the bodies of 20261016120000 (the pricing scope lock), 20261105120000
-- (the hold reference and the transaction id), 20261107120000 (the hold journal guards) and
-- 20261108120000 (the wallet and escrow accounts), which take their locks themselves, and
-- 20261016120000's commission history (the scope change and the effective-dated trigger, INSERT and
-- UPDATE only), then drops the scope decisions, the note trigger, their functions, the leg predicate
-- and the gate.
-- Nothing was rewritten going up, so nothing is put back; the scope decisions are this migration's
-- own and go with it. The service calls the gate itself (`lockReadCommitted`): roll the release
-- back first, or a reward, participation or recognition rule write is refused (fails closed) until
-- it is.
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

-- 20261016120000's commission history: the instant in the session's setting again, INSERT and UPDATE.
CREATE OR REPLACE FUNCTION commission_rule_scope_change(
  organization_id TEXT, business_line "BusinessLine", transaction_type "TransactionType"
) RETURNS TIMESTAMP(3) AS $$
DECLARE
  scope_key BIGINT := commission_rule_scope_key(organization_id, business_line, transaction_type);
  setting TEXT := 'rasta.commission_rule_scope_' || to_hex(scope_key);
  decided TEXT := NULLIF(current_setting(setting, true), '');
BEGIN
  IF decided IS NULL THEN
    PERFORM pg_advisory_xact_lock(scope_key);
    decided := to_char(date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
                       'YYYY-MM-DD"T"HH24:MI:SS.MS');
    PERFORM set_config(setting, decided, true);
  END IF;
  RETURN decided::TIMESTAMP(3);
END; $$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION commission_rule_effective_dated() RETURNS TRIGGER AS $$
DECLARE at TIMESTAMP(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row naming no scope has no lock; `ck_commission_rule_scope` refuses it.
    IF NEW."business_line" IS NOT NULL OR NEW."transaction_type" IS NOT NULL THEN
      PERFORM commission_rule_scope_change(NEW."organization_id", NEW."business_line", NEW."transaction_type");
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."organization_id", NEW."business_line", NEW."transaction_type", NEW."rate_basis_points",
      NEW."min_amount_minor", NEW."max_amount_minor", NEW."valid_from")
     IS DISTINCT FROM
     (OLD."organization_id", OLD."business_line", OLD."transaction_type", OLD."rate_basis_points",
      OLD."min_amount_minor", OLD."max_amount_minor", OLD."valid_from") THEN
    RAISE EXCEPTION 'commission_rule terms never change: a new rate, scope or start is a new rule'
      USING ERRCODE = 'restrict_violation';
  END IF;
  at := commission_rule_scope_change(OLD."organization_id", OLD."business_line", OLD."transaction_type");
  IF NEW."status" IS DISTINCT FROM OLD."status" AND OLD."valid_from" <= at THEN
    RAISE EXCEPTION 'a commission rule in force keeps its status: end it with valid_to'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."valid_to" IS DISTINCT FROM OLD."valid_to" THEN
    IF OLD."valid_to" IS NOT NULL AND OLD."valid_to" <= at THEN
      RAISE EXCEPTION 'a commission rule that has ended cannot be moved or reopened'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."valid_to" IS NOT NULL AND NEW."valid_to" < at THEN
      RAISE EXCEPTION 'a commission rule is ended from now on, never in the past'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER "trg_commission_rule_history_kept" ON "commission_rule";
DROP TRIGGER "trg_commission_rule_effective_dated" ON "commission_rule";
CREATE TRIGGER "trg_commission_rule_effective_dated"
  BEFORE INSERT OR UPDATE ON "commission_rule"
  FOR EACH ROW EXECUTE FUNCTION commission_rule_effective_dated();
DROP TABLE "commission_rule_scope_decision";
DROP FUNCTION commission_rule_scope_decided();
DROP TRIGGER "trg_ledger_entry_wallet_debits_noted" ON "ledger_entry";
DROP FUNCTION note_wallet_account_debits();
DROP FUNCTION wallet_account_debited_later(TEXT);
DROP FUNCTION read_committed_xact_lock(BIGINT);
DROP FUNCTION read_committed_xact_lock(INTEGER, INTEGER);
DROP FUNCTION read_committed_xact_lock_shared(BIGINT);

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109120000_guards_read_committed';

COMMIT;
