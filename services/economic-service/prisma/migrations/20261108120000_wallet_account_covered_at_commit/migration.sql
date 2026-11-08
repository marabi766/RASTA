-- A wallet's ledger never owes its owner less than nothing, at commit (FU-228).
--
-- ## Where the balance lives
--
-- In the journal rows. `wallet` stores a projection: available = Σ(credit − debit) of the owner's
-- WALLET account, pending = the same of its ESCROW account, ledger = their sum, recomputed from
-- `ledger_entry` under the wallet's row lock (`WalletRepository.recomputeFromLedger`, ADR-034).
-- `ck_wallet_balances` holds that projection at zero or above, but only when something rewrites it.
-- A leg posted without the recompute (a hand-written debit, a new path) is asked by nothing, and the
-- account owes less than nothing until the balance audit reads it.
--
-- ## The guard, and why this one
--
-- - A CHECK sees one row, and the balance is a sum over many. A running-balance row would be a
--   second stored balance, and the projection already is one: it drifts by not being written.
--   So the ledger itself is asked.
-- - `trg_ledger_entry_wallet_covered`, a constraint trigger INITIALLY DEFERRED on every DEBIT leg (a
--   CREDIT only raises the sum). At commit, for a WALLET or ESCROW account, it sums the account's
--   legs and refuses below zero. Deferred, because legs arrive one statement at a time.
-- - Purpose, not type, decides: the projection counts every WALLET and ESCROW account as credit-
--   natured, and purpose never changes (`trg_ledger_account_identity_fixed`).
-- - Concurrency: two debits of one account, each committing, each saw only its own leg. Now each
--   takes a transaction lock on the account id before it sums, so the later waits for the earlier's
--   commit and then sums both. Only READ COMMITTED reads after the wait; SERIALIZABLE aborts one of
--   two that cross only when both are SERIALIZABLE (#936 r1 F1). So every other level is refused,
--   with a code no client retries. No writer of this service posts a leg under another level. The
--   service's own debits already hold the wallet row lock, so for them the lock never waits.
--
-- ## On a database in use
--
-- No leg is rewritten. If a WALLET or ESCROW account already sums below zero, this refuses, says how
-- many, and creates nothing: which entry is wrong is for a human to correct, by a journal.
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

LOCK TABLE "ledger_entry" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE overdrawn BIGINT;
BEGIN
  SELECT count(*) INTO overdrawn FROM (
    SELECT 1 FROM "ledger_entry" e JOIN "ledger_account" a ON a."id" = e."account_id"
     WHERE a."purpose" IN ('WALLET', 'ESCROW')
     GROUP BY e."account_id"
    HAVING SUM(CASE e."direction" WHEN 'CREDIT' THEN e."amount_minor" ELSE -e."amount_minor" END) < 0) o;
  IF overdrawn > 0 THEN
    RAISE EXCEPTION 'ledger_entry: % WALLET or ESCROW account(s) already sum below zero; refusing to guard a ledger that is already overdrawn, and changing nothing', overdrawn
      USING ERRCODE = 'check_violation',
            HINT = 'List them: SELECT e.account_id, SUM(CASE e.direction WHEN ''CREDIT'' THEN e.amount_minor ELSE -e.amount_minor END) AS balance FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id WHERE a.purpose IN (''WALLET'', ''ESCROW'') GROUP BY e.account_id HAVING SUM(CASE e.direction WHEN ''CREDIT'' THEN e.amount_minor ELSE -e.amount_minor END) < 0; correct each with a journal, then: prisma migrate resolve --rolled-back 20261108120000_wallet_account_covered_at_commit, and deploy again.';
  END IF;
END
$$;

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

CREATE CONSTRAINT TRIGGER "trg_ledger_entry_wallet_covered"
  AFTER INSERT ON "ledger_entry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."direction" = 'DEBIT')
  EXECUTE FUNCTION assert_wallet_account_covered();
