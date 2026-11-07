-- Money moves only against a funded hold of the transaction's own (FU-163, FU-164; D-130).
--
-- ## What a hold has to be
--
-- `wallet_hold` is a claim that money sits in escrow, and nothing tied the claim to the money:
-- `placed_journal_id` is nullable free text. A hold written by hand, with no journal behind it,
-- counted as proof (`transaction_own_hold_for_terms`, 20261106120000), and settling or refunding it
-- took the amount out of the escrow of the wallet's other obligations.
--
-- `wallet_hold_funded(id)` is the one answer. D-130 asks `placed_journal_id IS NOT NULL`; with no
-- foreign key, any text satisfies that, so it asks what the column claims (#859 r1, F1):
--
--   - the hold is in its wallet's currency;
--   - the journal is a FUNDS_HELD on the owner's books, not reversed, of the obligation the hold's
--     purpose names: a transaction's own, or for a refund the top-up of that intent, for the intent's
--     amount and currency. A purpose not named here is funded by nothing;
--   - the journal's NET movement into the owner's ESCROW in that currency is exactly the amount. A
--     credit alone is not funding: a journal crediting and debiting escrow moves nothing. The amount
--     is positive (`ck_wallet_hold_amount_positive`), so the net is too.
--
-- It is asked of RELEASED holds too (`enforce_transaction_settlement_authority`), so it says "this
-- was funded", not "this is still held": what keeps funding from being spent twice is that a hold
-- cannot be rewritten to spend it again.
--
--   - One journal backs one hold, for good: `wallet_hold_placed_journal_id_key`. Holds are never
--     deleted and the pointer never changes, so a journal once named stays spent.
--   - `trg_wallet_hold_terms_fixed`: the pointer, amount and currency never change, not even from
--     NULL (`trg_wallet_hold_reference_bound` already fixes wallet, purpose and obligation). A
--     resolved hold is final: never ACTIVE again, nor resolved another way. A retry is a new hold
--     funded by a new journal, which is what `WalletService.placeHold` does.
--
-- Every hold `WalletService.placeHold` writes is funded, in one transaction.
--
--   - `transaction_own_hold_for_terms` asks it, so `transaction_held_proven` (the API's `heldProven`,
--     which the order saga and the web read), `transaction_settlement_barred` and the operator's
--     CONFIRMED all do.
--   - `trg_wallet_hold_resolved_only_funded`: an unfunded hold is never resolved, for any purpose:
--     `ck_wallet_hold_resolution` asks a journal of every resolution, and that journal debits escrow.
--     Named to run after `trg_wallet_hold_release_settlement_authority`, which keeps its own words.
--     `trg_wallet_hold_inserted_only_funded` is the same for a row inserted already resolved: that is
--     what the settlement proof reads, and it runs at commit, after the move has been asked.
--   - `WalletService.placeHold`: a retry returns an existing hold only if it is funded and in the
--     wallet's currency, and `PaymentService.refund` asks both before the provider: otherwise it
--     would ask with nothing held for that currency and then fail to record it.
--   - `enforce_transaction_settlement_authority`: settle() has released the hold by the time it moves
--     the row, and the RELEASED hold that speaks for it has to be funded too.
--   - `decide_transaction_hold`: VOIDED says nothing is held, so an unfunded hold no longer refuses it.
--
-- ## What may pay with nothing held
--
-- `transaction_settlement_barred` asked this only of a row on the list, and RESTORED was left out.
-- Now anything that has ever claimed escrow pays only from a funded hold of its own for its exact
-- terms, whatever its list entry, decision, status or authorisation says:
--
--   - it is on `transaction_hold_reconciliation`, under ANY outcome, RESTORED included (D-130);
--   - it names, or is named by, a hold of its own in any status;
--   - it has ever been HELD (`held_at`, below).
--
-- What is left is an obligation that never claimed escrow: recorded from an approval (ADR-032), or
-- CREATED and authorised with no hold. Only that debits the spendable balance. An outcome or status
-- nobody thought of here is barred the same way, since what pays is named and not what does not.
--
-- ## `held_at`: why a column
--
-- FU-164: a HELD row on no list, with no hold, moves to PENDING_SETTLEMENT by `authorise-settlement`
-- (or to DISPUTED and back by a resolution). There it reads exactly as an obligation that never
-- claimed escrow, so settlement debited the spendable balance. Nothing on the row said it had been
-- HELD. `trg_transaction_held_at` stamps the first moment it says HELD, whoever writes it, and no
-- writer can set or clear the column.
--
-- ## On a database already in use
--
-- No production rows exist as of D-130; this is what would happen to them:
--
--   - Two holds naming one journal fail this migration, on the unique index, and nothing changes. The
--     funding of at most one of them is real and only a person can tell which.
--   - An ACTIVE hold with no proof of funding becomes unproven and is never payable: `heldProven`
--     false, settlement and refund refused, no journal. It is not changed, and a WARNING counts them.
--     The balance audit already reports it (`pending` is the sum of ACTIVE holds). Only a person ends
--     its row: a listed one can be VOIDED, which records that nothing is held; one on no list has
--     nothing to decide; and nothing in the service closes the hold.
--   - `held_at` is backfilled, at this migration's instant, for a row HELD now or with a hold of its
--     own in any status. A row that was HELD in the past, has no hold, and has moved on to
--     PENDING_SETTLEMENT or DISPUTED cannot be told from an obligation that never claimed escrow, so
--     it stays payable from spendable, as it was. Listed rows are barred regardless. D-130 accepts
--     this only because no such rows exist: confirm that before deploying over real data. The
--     `TRANSACTION_STATUS_CHANGED` outbox history can name such rows.
--   - A listed RESTORED row with nothing held stays PENDING_SETTLEMENT and refuses to settle. A refund
--     ends it with no money moved. A statement obligation refuses that too (Q-97): blocked, with
--     the owner's question pending, and `assertSettlementReady` says so.
--   - A second WARNING counts the open rows this leaves barred, RESTORED ones among them.
--
-- Bounded: `lock_timeout` for the locks, `statement_timeout` for the scans (default 5 s, raised for one
-- run by `RASTA_MIGRATION_STATEMENT_TIMEOUT`). A settlement in flight holds its row lock while it waits
-- for `wallet_hold`, so it can deadlock with `ALTER TABLE` here: PostgreSQL aborts one of the two, which
-- leaves nothing half-done (each is one transaction), and the loser is retried.
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

LOCK TABLE "wallet_hold", "transaction" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "transaction" ADD COLUMN "held_at" TIMESTAMP(3);

-- Before the trigger below, which would take this value back off a row not HELD now.
UPDATE "transaction" t
   SET "held_at" = CURRENT_TIMESTAMP
 WHERE t."status" = 'HELD'
    OR EXISTS (SELECT 1 FROM transaction_holds(t."id", t."organization_id"));

CREATE OR REPLACE FUNCTION stamp_transaction_held_at() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."held_at" IS NOT NULL THEN
    NEW."held_at" := OLD."held_at";
  ELSIF NEW."status" = 'HELD' THEN
    NEW."held_at" := CURRENT_TIMESTAMP;
  ELSE
    NEW."held_at" := NULL;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Every update, not `UPDATE OF status`: the column itself is what a writer must not reach.
CREATE TRIGGER "trg_transaction_held_at"
  BEFORE INSERT OR UPDATE ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION stamp_transaction_held_at();

CREATE UNIQUE INDEX "wallet_hold_placed_journal_id_key" ON "wallet_hold" ("placed_journal_id");

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
       -- A leg's organization and currency are its account's (`fk_ledger_entry_account_identity`).
       AND (SELECT SUM(CASE e."direction" WHEN 'CREDIT' THEN e."amount_minor" ELSE -e."amount_minor" END)
              FROM "ledger_entry" e
              JOIN "ledger_account" a ON a."id" = e."account_id"
             WHERE e."journal_id" = j."id"
               AND a."purpose" = 'ESCROW'
               AND a."organization_id" = h."organization_id"
               AND a."currency" = h."currency") = h."amount_minor");
$$ LANGUAGE sql STABLE;

-- The triggers and the service run as the writer, and PUBLIC has no EXECUTE on what the migrator
-- creates. infrastructure/docker/postgres/lib/runtime-function-grants.txt names it too.
GRANT EXECUTE ON FUNCTION wallet_hold_funded(TEXT) TO rasta_economic;

CREATE OR REPLACE FUNCTION transaction_own_hold_for_terms(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "transaction" t, transaction_holds(t."id", t."organization_id") h
     WHERE t."id" = subject
       AND h."status" = 'ACTIVE'
       AND h."amount_minor" = t."gross_amount_minor"
       AND h."currency" = t."currency"
       AND wallet_hold_funded(h."id"));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION transaction_settlement_barred(subject TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "transaction" t
     WHERE t."id" = subject
       AND (transaction_hold_decision_unresolved(t."id")
            OR (NOT transaction_own_hold_for_terms(t."id")
                AND (t."held_at" IS NOT NULL
                     OR EXISTS (SELECT 1 FROM "transaction_hold_reconciliation" c
                                 WHERE c."transaction_id" = t."id")
                     OR EXISTS (SELECT 1 FROM transaction_holds(t."id", t."organization_id"))))));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION enforce_wallet_hold_resolved_only_funded() RETURNS TRIGGER AS $$
BEGIN
  -- The id never changes, and on an update this reads the row as it stands: before the resolution.
  IF NOT wallet_hold_funded(NEW."id") THEN
    RAISE EXCEPTION 'A hold never funded moves no money: nothing resolves it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_hold_resolved_only_funded';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_wallet_hold_resolved_only_funded"
  BEFORE UPDATE OF "status" ON "wallet_hold"
  FOR EACH ROW
  WHEN (OLD."status" = 'ACTIVE' AND NEW."status" <> 'ACTIVE')
  EXECUTE FUNCTION enforce_wallet_hold_resolved_only_funded();

-- After: the predicate reads the row.
CREATE TRIGGER "trg_wallet_hold_inserted_only_funded"
  AFTER INSERT ON "wallet_hold"
  FOR EACH ROW
  WHEN (NEW."status" <> 'ACTIVE')
  EXECUTE FUNCTION enforce_wallet_hold_resolved_only_funded();

CREATE OR REPLACE FUNCTION enforce_wallet_hold_terms_fixed() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'A resolved hold is final: a retry is a new hold funded by a new journal'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_wallet_hold_terms_fixed';
  END IF;
  IF (OLD."amount_minor", OLD."currency", OLD."placed_journal_id")
     IS DISTINCT FROM (NEW."amount_minor", NEW."currency", NEW."placed_journal_id") THEN
    RAISE EXCEPTION 'What a hold holds, and the journal that funded it, never change'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_wallet_hold_terms_fixed';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Every update, not `UPDATE OF`: whatever a writer sets, a resolved row stays as it is. Named to run
-- after the triggers above, which keep their own words.
CREATE TRIGGER "trg_wallet_hold_terms_fixed"
  BEFORE UPDATE ON "wallet_hold"
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_hold_terms_fixed();

-- 20261106120000's body: the RELEASED hold has to be funded, and the words no longer say a decision.
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
          AND h."currency" = OLD."currency"
          AND wallet_hold_funded(h."id")) THEN
    RAISE EXCEPTION 'This transaction settles only from a funded hold of its own: no decision or authorisation pays it otherwise'
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

-- 20261106120000's body: an unfunded hold no longer refuses VOIDED, which is then simply true.
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
    RAISE EXCEPTION 'transaction %: HELD is confirmed only by its own active funded hold for its amount and currency; VOIDED says nothing is held', subject."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF subject.status = 'HELD' THEN
    own_hold := EXISTS (SELECT 1 FROM transaction_holds(subject."id", subject."organization_id") h
                         WHERE h."status" = 'ACTIVE' AND wallet_hold_funded(h."id"));
    IF p_decision = 'VOIDED' AND own_hold THEN
      RAISE EXCEPTION 'transaction %: VOIDED says nothing is held, and it has an active funded hold of its own: refund it, or CONFIRMED', subject."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The primary key refuses a second decision; the checks refuse an unknown word or an empty reason.
  INSERT INTO "transaction_hold_decision" ("transaction_id", "decision", "reason", "decided_by")
  VALUES (subject."id", p_decision, btrim(p_reason), session_user);

  -- The evidence only: no decision moves the row or authorises anything (D-123).
  RETURN subject.status;
END; $$ LANGUAGE plpgsql;

DO $$
DECLARE found BIGINT;
BEGIN
  SELECT count(*) INTO found FROM "wallet_hold" h
   WHERE h."status" = 'ACTIVE' AND NOT wallet_hold_funded(h."id");
  IF found > 0 THEN
    RAISE WARNING 'wallet_hold: % ACTIVE hold(s) have no proof of funding: none proves or pays anything, none is refunded, and they are left as they are', found
      USING HINT = 'SELECT id, reference, reference_type FROM wallet_hold WHERE status = ''ACTIVE'' AND NOT wallet_hold_funded(id); docs/runbooks/transaction-hold-decision.md';
  END IF;
  SELECT count(*) INTO found FROM "transaction" t
   WHERE t."status" IN ('CREATED', 'HELD', 'PENDING_SETTLEMENT', 'DISPUTED')
     AND transaction_settlement_barred(t."id");
  IF found > 0 THEN
    RAISE WARNING 'transaction: % open row(s) have claimed escrow and hold no funded hold of their own: they pay nothing until one exists, and nothing moved', found
      USING HINT = 'SELECT id, status, source_type FROM "transaction" WHERE status IN (''CREATED'', ''HELD'', ''PENDING_SETTLEMENT'', ''DISPUTED'') AND transaction_settlement_barred(id); docs/runbooks/transaction-hold-decision.md';
  END IF;
END
$$;
