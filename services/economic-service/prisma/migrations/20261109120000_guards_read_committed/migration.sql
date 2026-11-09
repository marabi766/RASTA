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
--   once `rasta.commission_rule_scope_<key>` was set, which any session may set, and was decided
--   at the instant that setting named: the instant now lives where no session writes it, and one
--   trigger holds every write of a rule to it (below, #1016 r1 F1).
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

-- ---- 20261016120000's commission history: one boundary, decided at an instant no session sets ----
--
-- A change of a scope's rules is decided at one instant, the database clock read once the scope's
-- lock is held, and the service and the trigger below read that same instant. 20261016120000 kept it
-- in `rasta.commission_rule_scope_<key>`, a setting any session may write: set it before the rule's
-- start and a rule in force could be withdrawn (#1016 r1 F1). The instant now lives in
-- `commission_rule_scope_decision`, one row per transaction and scope, whose trigger takes the lock
-- through the gate and then writes the transaction's id and the clock itself, whatever the INSERT
-- said; the row is never updated, deleted or truncated. A transaction reads only its own row
-- (`pg_current_xact_id()`, 64-bit, never reused), and the row goes with a rolled-back savepoint, as
-- the lock does. The table grows by one row per scope per rule change (an administrator's act).
CREATE TABLE "commission_rule_scope_decision" (
  "transaction_id" xid8         NOT NULL,
  "scope_key"      BIGINT       NOT NULL,
  "decided_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "commission_rule_scope_decision_pkey" PRIMARY KEY ("transaction_id", "scope_key")
);

CREATE FUNCTION commission_rule_scope_decided() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IS DISTINCT FROM 'INSERT' THEN
    RAISE EXCEPTION 'a commission scope decision is never changed or removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM read_committed_xact_lock(NEW."scope_key");
  NEW."transaction_id" := pg_catalog.pg_current_xact_id();
  NEW."decided_at" := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_commission_rule_scope_decided"
  BEFORE INSERT OR UPDATE OR DELETE ON "commission_rule_scope_decision"
  FOR EACH ROW EXECUTE FUNCTION commission_rule_scope_decided();
CREATE TRIGGER "trg_commission_rule_scope_decision_kept"
  BEFORE TRUNCATE ON "commission_rule_scope_decision"
  FOR EACH STATEMENT EXECUTE FUNCTION commission_rule_scope_decided();

-- The scope's lock, through the gate, on every call; then this transaction's decided instant.
CREATE OR REPLACE FUNCTION commission_rule_scope_change(
  organization_id TEXT, business_line "BusinessLine", transaction_type "TransactionType"
) RETURNS TIMESTAMP(3) AS $$
DECLARE
  scope BIGINT := commission_rule_scope_key(organization_id, business_line, transaction_type);
  decided TIMESTAMP(3);
BEGIN
  PERFORM read_committed_xact_lock(scope);
  SELECT d."decided_at" INTO decided FROM "commission_rule_scope_decision" d
   WHERE d."transaction_id" OPERATOR(pg_catalog.=) pg_catalog.pg_current_xact_id()
     AND d."scope_key" OPERATOR(pg_catalog.=) scope;
  IF NOT FOUND THEN
    INSERT INTO "commission_rule_scope_decision" ("scope_key") VALUES (scope)
      RETURNING "decided_at" INTO decided;
  END IF;
  RETURN decided;
END; $$ LANGUAGE plpgsql VOLATILE;

-- Every write of a rule, at that instant: an INSERT (COPY, the insert branch of ON CONFLICT) starts
-- now or later, never before (F1 iii: a backdated rule would reprice facts that occurred before
-- it); a rule that has started is history, so it is never deleted (F1 ii) and keeps its status;
-- the UPDATE rules are 20261016120000's, unchanged. TRUNCATE is refused outright.
CREATE OR REPLACE FUNCTION commission_rule_effective_dated() RETURNS TRIGGER AS $$
DECLARE at TIMESTAMP(3);
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'commission rules are history: never truncated'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- A row naming no scope has no lock; `ck_commission_rule_scope` refuses it.
    IF NEW."business_line" IS NULL AND NEW."transaction_type" IS NULL THEN
      RETURN NEW;
    END IF;
    at := commission_rule_scope_change(NEW."organization_id", NEW."business_line", NEW."transaction_type");
    IF NEW."valid_from" < at THEN
      RAISE EXCEPTION 'a commission rule starts now or later, never in the past: a backdated rule would reprice what already occurred'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- A stored rule always names its scope (`ck_commission_rule_scope`); one that did not has a NULL
  -- key, which the gate refuses.
  at := commission_rule_scope_change(OLD."organization_id", OLD."business_line", OLD."transaction_type");
  IF TG_OP = 'DELETE' THEN
    IF OLD."valid_from" <= at THEN
      RAISE EXCEPTION 'a commission rule that has started is history: it is never deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."organization_id", NEW."business_line", NEW."transaction_type", NEW."rate_basis_points",
      NEW."min_amount_minor", NEW."max_amount_minor", NEW."valid_from")
     IS DISTINCT FROM
     (OLD."organization_id", OLD."business_line", OLD."transaction_type", OLD."rate_basis_points",
      OLD."min_amount_minor", OLD."max_amount_minor", OLD."valid_from") THEN
    RAISE EXCEPTION 'commission_rule terms never change: a new rate, scope or start is a new rule'
      USING ERRCODE = 'restrict_violation';
  END IF;
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

DROP TRIGGER "trg_commission_rule_effective_dated" ON "commission_rule";
CREATE TRIGGER "trg_commission_rule_effective_dated"
  BEFORE INSERT OR UPDATE OR DELETE ON "commission_rule"
  FOR EACH ROW EXECUTE FUNCTION commission_rule_effective_dated();
CREATE TRIGGER "trg_commission_rule_history_kept"
  BEFORE TRUNCATE ON "commission_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION commission_rule_effective_dated();

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
