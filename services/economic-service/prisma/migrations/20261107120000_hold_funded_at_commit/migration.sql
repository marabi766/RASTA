-- A hold is funded at commit, by the payer's own money (FU-182; #859, D-130).
--
-- `wallet_hold_funded` (20261106130000) is the one answer to "does money sit in escrow for this
-- hold". Two things were left open:
--
-- ## (a) It was asked when the hold was written, not at commit
--
-- `trg_wallet_hold_resolved_only_funded` and `trg_wallet_hold_inserted_only_funded` ask the
-- predicate at their statement. A journal opened in the same transaction still takes legs
-- (`trg_ledger_entry_open_journal`), so a transaction could resolve a hold over a journal that
-- funded it at that statement, append a leg taking the escrow back out, and commit a resolution
-- that moved money nothing held. A reversal of the funding journal, in any later transaction, did
-- the same to a hold already resolved: escrow debited twice for one credit.
--
--   - `trg_wallet_hold_funded_at_commit`, a constraint trigger INITIALLY DEFERRED: at commit, every
--     hold this transaction wrote that names a journal, or is resolved, is funded by the journal as it
--     stands then. "Names a journal" includes ACTIVE: a hold naming a journal that does not fund it is
--     never written; unproven is a hold naming none (D-130's legacy rows), which proves nothing.
--   - `trg_ledger_entry_hold_journal_closed`: a journal takes no leg once a hold names it, refused at
--     the statement. It is what still holds when a session runs `SET CONSTRAINTS ... IMMEDIATE`, and
--     it gives the error where the edit is made. `WalletService.placeHold` posts the journal whole
--     before it writes the hold.
--   - `trg_journal_hold_funding_final`: a journal a hold names is never reversed. A hold goes back by
--     its refund, a new journal (`WalletService.refundHold`); `JournalReversalService` already
--     refuses a FUNDS_HELD journal, and this says it to every writer.
--   - The two early triggers stay: they refuse at the statement, which is the better error for the
--     service. They are not the guard; the deferred one is.
--   - A hold naming a journal and a reversal of it, in two transactions at once, take one lock on the
--     journal's id, so the later sees the earlier (below).
--
-- ## (b) The money's source was not asked
--
-- The predicate counted net movement into the owner's escrow, wherever it came from: a FUNDS_HELD
-- journal crediting escrow against platform clearing, commission or reward expense, or another
-- organization's wallet, made escrow out of nothing and funded a hold that then paid the payee.
--
-- What funds a hold is the posting `WalletService.placeHold` makes, and only that: a FUNDS_HELD
-- journal every leg of which is on the owner's own WALLET or ESCROW account in the hold's currency,
-- netting +amount into escrow and -amount out of the wallet. The wallet's spendable balance is the
-- source, and it is what the payment top-up (WALLET_TOP_UP, from PAYMENT_CLEARING), a reward, a
-- settlement or a refund credited. A leg on any other account, of any organization, funds nothing.
-- Every writer of escrow legs, for the record (economic-service src):
--
--   - `WalletService.placeHold`    FUNDS_HELD      DEBIT own WALLET, CREDIT own ESCROW (the funding);
--   - `WalletService.refundHold`   FUNDS_REFUNDED  DEBIT own ESCROW, CREDIT own WALLET;
--   - `SettlementService.postSettlementJournal`  SETTLEMENT  DEBIT payer ESCROW (or WALLET), CREDIT
--     payee WALLET and COMMISSION_REVENUE;
--   - `LedgerService.reverse`      REVERSAL        the mirror of a journal: of one a hold names,
--     refused (`trg_journal_hold_funding_final`; `CORRECTION_OF` refuses every FUNDS_HELD at the
--     API), of a SETTLEMENT by `trg_journal_settlement_reversal_final`.
-- No SQL function in this schema writes a journal; `WalletService.credit` (WALLET_TOP_UP,
-- REWARD_GRANT) touches no escrow.
--
-- ## On a database already in use
--
-- Nothing is rewritten. The triggers fire on writes, so a hold written before this keeps the row it
-- has; the predicate now refuses one whose journal took money from elsewhere, so such a hold is
-- unproven from here on (ACTIVE: never payable, never resolved; RELEASED: speaks for no settlement).
-- A WARNING counts them, by status. No production rows exist as of D-130.
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

LOCK TABLE "wallet_hold", "journal", "ledger_entry" IN SHARE ROW EXCLUSIVE MODE;

-- 20261106130000's body, and every leg on the owner's own wallet or escrow in the hold's currency.
CREATE OR REPLACE FUNCTION wallet_hold_funded(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "wallet_hold" h
      JOIN "wallet" w ON w."id" = h."wallet_id"
                     AND w."organization_id" = h."organization_id"
                     AND w."currency" = h."currency"
      JOIN "journal" j ON j."id" = h."placed_journal_id"
                      AND j."journal_type" = 'FUNDS_HELD'
                      AND j."organization_id" = h."organization_id"
     WHERE h."id" = subject
       AND CASE h."reference_type"
             WHEN 'TRANSACTION' THEN j."transaction_id" = h."reference"
             WHEN 'PAYMENT_REFUND' THEN EXISTS (
               SELECT 1 FROM "payment_intent" p
                WHERE p."id" = h."reference"
                  AND p."wallet_id" = h."wallet_id"
                  AND p."transaction_id" = j."transaction_id"
                  AND p."amount_minor" = h."amount_minor"
                  AND p."currency" = h."currency")
             ELSE FALSE
           END
       AND NOT EXISTS (SELECT 1 FROM "journal" r WHERE r."reverses_id" = j."id")
       -- No legs: every aggregate is NULL, and so is the answer. One `organization_id` per
       -- (purpose, currency) account (`ledger_account_organization_id_purpose_currency_key`).
       AND (SELECT bool_and(a."organization_id" = h."organization_id"
                            AND a."currency" = h."currency"
                            AND a."purpose" IN ('WALLET', 'ESCROW'))
                   AND SUM(CASE WHEN a."purpose" <> 'ESCROW' THEN 0
                                WHEN e."direction" = 'CREDIT' THEN e."amount_minor"
                                ELSE -e."amount_minor" END) = h."amount_minor"
                   AND SUM(CASE WHEN a."purpose" <> 'WALLET' THEN 0
                                WHEN e."direction" = 'DEBIT' THEN e."amount_minor"
                                ELSE -e."amount_minor" END) = h."amount_minor"
              FROM "ledger_entry" e
              JOIN "ledger_account" a ON a."id" = e."account_id"
             WHERE e."journal_id" = j."id") IS TRUE);
$$ LANGUAGE sql STABLE;

-- A hold naming a journal and a reversal of that journal (`trg_journal_hold_funding_final`) take the
-- same transaction lock before they look, so one waits for the other and then sees it. Only READ
-- COMMITTED reads after the wait. REPEATABLE READ and SERIALIZABLE read a snapshot from before it,
-- and SERIALIZABLE aborts one of two that cross only when both are SERIALIZABLE: against a READ
-- COMMITTED writer it commits a hold funded by a reversed journal, or the reversal of a journal a
-- hold names (#936 r1 F1). So both refuse every level but READ COMMITTED, with a code no client
-- retries (as `trg_settlement_reversal_cap`, 20261104120000). No writer of this service writes
-- either under another (its REPEATABLE READ reads are READ ONLY). Inline in both, so the runtime
-- role needs no EXECUTE.
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

-- `WHEN` is asked at each write, not at commit: a write leaving the row ACTIVE and naming no journal
-- queues nothing (it proves nothing), and every later write of the row is asked again. The pointer
-- never goes from a journal to none (`trg_wallet_hold_terms_fixed`), nor a resolved row to ACTIVE.
CREATE CONSTRAINT TRIGGER "trg_wallet_hold_funded_at_commit"
  AFTER INSERT OR UPDATE ON "wallet_hold"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."placed_journal_id" IS NOT NULL OR NEW."status" <> 'ACTIVE')
  EXECUTE FUNCTION assert_wallet_hold_funded_at_commit();

CREATE OR REPLACE FUNCTION reject_hold_journal_leg() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "wallet_hold" h WHERE h."placed_journal_id" = NEW."journal_id") THEN
    RAISE EXCEPTION 'A journal takes no leg once a hold names it'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_ledger_entry_hold_journal_closed';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_ledger_entry_hold_journal_closed"
  BEFORE INSERT ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION reject_hold_journal_leg();

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

CREATE TRIGGER "trg_journal_hold_funding_final"
  BEFORE INSERT ON "journal"
  FOR EACH ROW
  WHEN (NEW."reverses_id" IS NOT NULL)
  EXECUTE FUNCTION reject_hold_journal_reversal();

DO $$
DECLARE found TEXT;
BEGIN
  SELECT string_agg(n || ' ' || s, ', ' ORDER BY s) INTO found
    FROM (SELECT h."status"::text AS s, count(*) AS n FROM "wallet_hold" h
           WHERE h."placed_journal_id" IS NOT NULL AND NOT wallet_hold_funded(h."id")
           GROUP BY h."status") c;
  IF found IS NOT NULL THEN
    RAISE WARNING 'wallet_hold: holds naming a journal that is not the payer''s own wallet into its own escrow (%): from here on they prove nothing, and they are left as they are', found
      USING HINT = 'SELECT id, status, placed_journal_id FROM wallet_hold WHERE placed_journal_id IS NOT NULL AND NOT wallet_hold_funded(id); docs/runbooks/transaction-hold-decision.md';
  END IF;
END
$$;
