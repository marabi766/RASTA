-- Every guard that locks and then reads does so only under READ COMMITTED; a wallet or escrow
-- account is locked in id order and summed once per account (FU-268, #983 r1 F1-F3).
--
-- ## The class: lock, then read
--
-- A guard takes a transaction lock, then reads what a writer holding the same lock may just have
-- committed. Only READ COMMITTED reads it: each statement takes a new snapshot, so the read after
-- the wait sees the commit it waited for. REPEATABLE READ and SERIALIZABLE read the transaction's
-- first snapshot, from before the wait, and the lock protects nothing (#936 r1 F1). Three guards
-- refused the other levels inline; four did not:
--
-- - `enforce_wallet_hold_reference` and `enforce_transaction_id_unclaimed` (20261105120000): a hold
--   for anything else and a transaction with the same id could both be written;
-- - `commission_rule_scope_change` and `commission_pricing_scope_lock` (20261016120000): a pricing
--   could read the rules from before a change it had waited for. And a change took no lock at all
--   once `rasta.commission_rule_scope_<key>` was set, which any session may set: every write of a
--   scoped rule now takes the scope's lock through the gate (`trg_commission_rule_read_committed`).
--
-- So the lock itself is now the gate. `read_committed_xact_lock` and its shared and two-key forms
-- refuse a NULL key (which takes no lock) before they lock, and every level but READ COMMITTED
-- once they hold it.
-- Every guard of this service takes its lock through them, and the migration verifier refuses any
-- function of any service that names an advisory lock itself (`advisoryLockGateScript`).
-- `restrict_violation`: a refusal no client retries. No writer of this service posts under another
-- level (its REPEATABLE READ transactions are READ ONLY reads).
--
-- ## A wallet or escrow account at commit (20261108120000)
--
-- - Lock order (F1): each deferred check locked its own account, in the order the legs were
--   written, so two transactions debiting two accounts in opposite orders deadlocked at commit.
--   `trg_ledger_entry_wallet_debits_noted` notes, per statement, the WALLET and ESCROW accounts
--   the transaction debits (`rasta.wallet_covered_accounts`, transaction-local and undone with a
--   rolled-back savepoint). Every check locks all of them, sorted, before it sums. The note only
--   orders locks: a session that rewrites it can deadlock itself, and skips no check.
-- - Once per account (F2): every debit leg re-summed the account's whole history. A leg now skips
--   its sum only when a later debit leg of the same account was written by the same transaction
--   (same `xmin`, a later command `cmin`, or the same command and a greater id): that leg's check
--   runs after this one's and sums both, and it skips only for a later one still, so the last leg
--   always sums. The system columns are the proof, so nothing a session can set skips a sum.
--
-- ## search_path
--
-- The gate reads no relation and names every built-in by `pg_catalog`. The other functions read
-- their tables by name, as every function of this schema does: pinning their path (the FU-266 rule)
-- is refused by `check:utc-clock-sites` (a session setting that may move names), so it waits for
-- FU-266, which owns that guard's change.
SET LOCAL lock_timeout = '3s';

-- ---- the gate ----

CREATE FUNCTION read_committed_xact_lock(lock_key BIGINT)
RETURNS VOID AS $$
BEGIN
  IF lock_key IS NULL THEN
    RAISE EXCEPTION 'An advisory lock with no key locks nothing'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(lock_key);
  -- After the lock, as before: a refused level still waits its turn, then reads nothing.
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'A guard that locks and then reads runs only under READ COMMITTED'
      USING ERRCODE = 'restrict_violation';
  END IF;
END; $$ LANGUAGE plpgsql VOLATILE;

CREATE FUNCTION read_committed_xact_lock(lock_key INTEGER, lock_subkey INTEGER)
RETURNS VOID AS $$
BEGIN
  IF lock_key IS NULL OR lock_subkey IS NULL THEN
    RAISE EXCEPTION 'An advisory lock with no key locks nothing'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(lock_key, lock_subkey);
  -- After the lock, as before: a refused level still waits its turn, then reads nothing.
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'A guard that locks and then reads runs only under READ COMMITTED'
      USING ERRCODE = 'restrict_violation';
  END IF;
END; $$ LANGUAGE plpgsql VOLATILE;

CREATE FUNCTION read_committed_xact_lock_shared(lock_key BIGINT)
RETURNS VOID AS $$
BEGIN
  IF lock_key IS NULL THEN
    RAISE EXCEPTION 'An advisory lock with no key locks nothing'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(lock_key);
  -- After the lock, as before: a refused level still waits its turn, then reads nothing.
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'A guard that locks and then reads runs only under READ COMMITTED'
      USING ERRCODE = 'restrict_violation';
  END IF;
END; $$ LANGUAGE plpgsql VOLATILE;

-- The runtime role calls them through the guards below, which run as the writer
-- (runtime-function-grants.txt names them too).
GRANT EXECUTE ON FUNCTION read_committed_xact_lock(BIGINT) TO rasta_economic;
GRANT EXECUTE ON FUNCTION read_committed_xact_lock(INTEGER, INTEGER) TO rasta_economic;
GRANT EXECUTE ON FUNCTION read_committed_xact_lock_shared(BIGINT) TO rasta_economic;

-- ---- 20261016120000's commission scope locks, through the gate ----

CREATE OR REPLACE FUNCTION commission_pricing_scope_lock(
  organization_id TEXT, business_line "BusinessLine", transaction_type "TransactionType"
) RETURNS VOID AS $$
BEGIN
  PERFORM read_committed_xact_lock_shared(commission_rule_scope_key(NULL, business_line, transaction_type));
  PERFORM read_committed_xact_lock_shared(commission_rule_scope_key(organization_id, business_line, transaction_type));
END; $$ LANGUAGE plpgsql VOLATILE;

-- A change of a scope's rules: `commission_rule_scope_change` (its body stays as 20261016120000
-- wrote it: `check:utc-clock-sites` binds its review to that body) takes the scope's lock itself,
-- and skips it once the session holds the decided instant, a setting any session may write. So
-- every write of a scoped rule takes the same lock through the gate first, here, whatever the
-- setting says; the service does the same before it reads (`lockScopeForChange`).
CREATE FUNCTION enforce_commission_rule_read_committed() RETURNS TRIGGER AS $$
DECLARE subject RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    subject := NEW;
  ELSE
    subject := OLD;
  END IF;
  -- A row naming no scope has no lock; `ck_commission_rule_scope` refuses it.
  IF subject."business_line" IS NOT NULL OR subject."transaction_type" IS NOT NULL THEN
    PERFORM read_committed_xact_lock(
      commission_rule_scope_key(subject."organization_id", subject."business_line", subject."transaction_type"));
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_commission_rule_read_committed"
  BEFORE INSERT OR UPDATE ON "commission_rule"
  FOR EACH ROW EXECUTE FUNCTION enforce_commission_rule_read_committed();

-- ---- 20261105120000's hold reference and transaction id, through the gate ----

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
    PERFORM read_committed_xact_lock(20261105, hashtext(NEW."reference"));
    IF EXISTS (SELECT 1 FROM "transaction" t WHERE t."id" = NEW."reference") THEN
      RAISE EXCEPTION 'A hold for anything else names no transaction'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_hold_reference_bound';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_transaction_id_unclaimed() RETURNS TRIGGER AS $$
BEGIN
  PERFORM read_committed_xact_lock(20261105, hashtext(NEW."id"));
  IF EXISTS (SELECT 1 FROM "wallet_hold" h WHERE h."reference" = NEW."id") THEN
    RAISE EXCEPTION 'A transaction takes no id a hold has already named'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_transaction_id_unclaimed';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- ---- 20261107120000's hold journal guards: their inline refusal, now the gate's ----

CREATE OR REPLACE FUNCTION assert_wallet_hold_funded_at_commit() RETURNS TRIGGER AS $$
DECLARE
  pointer TEXT;
  lock_key BIGINT;
BEGIN
  -- The row as it stands at commit, not as this event saw it: a later write may have resolved it.
  SELECT h."placed_journal_id" INTO pointer FROM "wallet_hold" h
   WHERE h."id" = NEW."id" AND (h."placed_journal_id" IS NOT NULL OR h."status" <> 'ACTIVE');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF pointer IS NOT NULL THEN
    lock_key := hashtextextended('wallet_hold_journal:' || pointer, 0);
    PERFORM read_committed_xact_lock(lock_key);
  END IF;
  IF NOT wallet_hold_funded(NEW."id") THEN
    RAISE EXCEPTION 'At commit, a hold that names a journal or is resolved is funded by it: the payer''s own wallet into its own escrow'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_hold_funded_at_commit';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_hold_journal_reversal() RETURNS TRIGGER AS $$
DECLARE lock_key BIGINT;
BEGIN
  -- Only a FUNDS_HELD journal funds a hold (`wallet_hold_funded`); the lock is the one above.
  IF EXISTS (SELECT 1 FROM "journal" j WHERE j."id" = NEW."reverses_id" AND j."journal_type" = 'FUNDS_HELD') THEN
    lock_key := hashtextextended('wallet_hold_journal:' || NEW."reverses_id", 0);
    PERFORM read_committed_xact_lock(lock_key);
  END IF;
  IF EXISTS (SELECT 1 FROM "wallet_hold" h WHERE h."placed_journal_id" = NEW."reverses_id") THEN
    RAISE EXCEPTION 'A journal a hold names is never reversed: the hold goes back by its refund'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_journal_hold_funding_final';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- ---- 20261108120000's wallet and escrow accounts: id order, once per account ----

CREATE FUNCTION note_wallet_account_debits() RETURNS TRIGGER AS $$
DECLARE noted TEXT[];
BEGIN
  SELECT array_agg(s.account_id ORDER BY s.account_id COLLATE "C") INTO noted FROM (
    SELECT pg_catalog.unnest(COALESCE(NULLIF(pg_catalog.current_setting('rasta.wallet_covered_accounts', true), '')::TEXT[], '{}')) AS account_id
    UNION
    SELECT e."account_id" FROM added e JOIN "ledger_account" a ON a."id" = e."account_id"
     WHERE e."direction" = 'DEBIT' AND a."purpose" IN ('WALLET', 'ESCROW')) s;
  PERFORM pg_catalog.set_config('rasta.wallet_covered_accounts', COALESCE(noted, '{}')::TEXT, true);
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_ledger_entry_wallet_debits_noted"
  AFTER INSERT ON "ledger_entry"
  REFERENCING NEW TABLE AS added
  FOR EACH STATEMENT EXECUTE FUNCTION note_wallet_account_debits();

-- True when a later debit leg of the leg's account was written by the same transaction (see the
-- header): that leg's check comes after this one's, and its sum includes this leg.
CREATE FUNCTION wallet_account_debited_later(leg_id TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "ledger_entry" leg
      JOIN "ledger_entry" e ON e."account_id" = leg."account_id"
                           AND e."posted_at" >= leg."posted_at"
                           AND e."direction" = 'DEBIT'
                           AND e."xmin" = leg."xmin"
     WHERE leg."id" = leg_id
       AND (e."cmin"::TEXT::BIGINT, e."id" COLLATE "C") > (leg."cmin"::TEXT::BIGINT, leg."id" COLLATE "C"));
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION wallet_account_debited_later(TEXT) TO rasta_economic;

CREATE OR REPLACE FUNCTION assert_wallet_account_covered() RETURNS TRIGGER AS $$
DECLARE
  balance NUMERIC;
  account TEXT;
  lock_key BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ledger_account" a
                  WHERE a."id" = NEW."account_id" AND a."purpose" IN ('WALLET', 'ESCROW')) THEN
    RETURN NULL;
  END IF;
  -- Every account the transaction debits, in id order, before any is summed. Held ones return at once.
  FOR account IN
    SELECT DISTINCT x COLLATE "C" FROM pg_catalog.unnest(
      COALESCE(NULLIF(current_setting('rasta.wallet_covered_accounts', true), '')::TEXT[], '{}')
      || NEW."account_id") x
     ORDER BY 1
  LOOP
    lock_key := hashtextextended('wallet_account_covered:' || account, 0);
    PERFORM read_committed_xact_lock(lock_key);
  END LOOP;
  IF wallet_account_debited_later(NEW."id") THEN
    RETURN NULL;
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
