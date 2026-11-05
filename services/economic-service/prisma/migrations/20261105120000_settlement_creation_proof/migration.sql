-- A settlement proves it happened, when it is written (FU-097; review of #721 r2, F3).
--
-- A reversal believes a settlement only as far as its journal agrees, but that
-- proof runs at propose and apply. Until then the row itself was believed: anyone
-- able to INSERT could fabricate one, or reserve an unsettled transaction, since
-- `settlement.transaction_id` is UNIQUE and a row is never removed. So could a
-- `commission` row, whose `transaction_id` is UNIQUE too and which is append-only
-- too: the real settlement then fails on the key, for good. Both tables get one
-- proof, so does the move of a transaction to SETTLED, which alone reserved it as
-- well, and what the proof compares with holds still (below). `journal` and
-- `ledger_entry` are written by the proof's own transaction, and `ledger_account` is frozen.
--
-- ## The proof, at commit, of both rows at once
--
-- `settle()` writes journal, legs, hold, commission, settlement, and only then moves
-- the transaction to SETTLED, so nothing is true until its last step and the
-- triggers are deferred; that order is unchanged. `SET CONSTRAINTS ... IMMEDIATE`
-- only checks earlier, and so fails, on an unfinished settlement. At commit:
--
--   - this database transaction wrote the settlement, the commission, the journal and
--     the transaction row, which is SETTLED (`xmin`, as `trg_ledger_entry_open_journal`
--     reads it). So no row can lean on a journal somebody else left behind, or on a
--     transaction somebody else left SETTLED without writing to it too.
--   - the settlement says exactly what its transaction says: payer, payee, figures,
--     currency, instant; and the commission what the settlement says.
--   - the journal is SETTLEMENT, of this transaction, on the payer's books, and its
--     legs are exactly the settlement: one debit of the payer's WALLET or ESCROW for
--     gross; at most one credit of a REVENUE account labelled COMMISSION_REVENUE, for
--     the commission; at most one credit of the payee's WALLET, which the journal's
--     balance and `ck_settlement_amounts` make the net; no other leg.
--   - escrow and hold agree: an ESCROW debit exactly when this journal released the
--     payer's hold for this gross, and no hold of the transaction stays ACTIVE.
--
-- What it cannot tell apart: every one of these rows written correctly by hand, in
-- one transaction, a RELEASED hold among them if it likes. That is a settlement: the
-- money did move, balanced, on the transaction's own terms. Nor can SQL say whose
-- revenue account is the platform's (`ECONOMIC_PLATFORM_ORGANIZATION_ID` is the
-- service's setting), or whether the commission is what the rule's rate gives: its
-- rounding is the service's. A stray SETTLEMENT journal no settlement names is not
-- refused either: it backs nothing a reversal reads.
--
-- ## What the proof compares with holds still
--
-- It reads `transaction`, so a transaction that could be rewritten around it proves
-- nothing: terms lowered, settled for them, terms and status put back, and the real
-- settlement refused on the key. Nor one that could be replaced: deleted, or renamed
-- and its id reused, and written again under that id with another payee or gross; the
-- proof would compare the settlement with the replacement. `trg_transaction_terms_fixed`
-- holds every kind of obligation to what the proof reads, as a statement obligation
-- already was: never deleted, and its id, who pays whom, how much, in what and on which
-- line never change. Not its source or kind, which the proof does not read and ADR-032's
-- `quarantine_transaction_source` corrects. `trg_transaction_no_truncate` answers the
-- statement a row trigger never sees. `trg_transaction_status_edges`: SETTLED only from PENDING_SETTLEMENT and left
-- only by a reversal, and what it settled at stays. The service's one writer of these,
-- `TransactionRepository.transition`, only ever sets the rest.
--
-- ## Whose hold counts
--
-- `wallet_hold.reference` is free text, unique only per wallet, so a hold of another
-- organization, or for another purpose, could name this transaction's id and veto its
-- settlement. `transaction_holds` is the one answer to "the holds of this transaction":
-- purpose TRANSACTION, the payer's, on the payer's wallet. Every predicate here asks it:
-- the proof, the settlement authority of a transaction and of a release, and where a
-- resolved dispute returns to. `trg_wallet_hold_reference_bound` keeps the rows true for
-- it: a new hold is on a wallet of its own organization; for a transaction, it names one of
-- its own organization; for anything else, it names no transaction. Whose it is and what it
-- is for never change, a wallet never changes hands, and a hold is never deleted, or a hold
-- could step out of that answer.
-- A row from before this breaks none of it silently: no such hold counts, and the
-- migration says how many there are. What it cannot tell apart: a hold written by hand in
-- the payer's own name, on the payer's own wallet. That is the payer's hold: refused
-- settlements, no money moved.
--
-- ## The foreign keys
--
-- `settlement.journal_id` and `commission.journal_id` name a real journal. Immediate:
-- `settle()` posts the journal first. No Prisma relation, as with
-- `settlement_reversal.journal_id`: nothing reads through it.
--
-- ## Rows from before this migration
--
-- The triggers fire on INSERT, so they never judge an old row; this migration does,
-- once, by what can be asked of one: the journal exists and is its own, the
-- transaction is settled and agrees, the legs are the settlement, its commission
-- exists and agrees. Not the instant (the proof of a reversal never asked it), nor who
-- wrote what with which `xmin` (gone), nor the hold: those would condemn real money for
-- what an old release did not record. Every release wrote a commission with its journal
-- on every settlement, so a missing one, or a NULL journal, fails.
--
-- A row that fails is not changed and not deleted: it is the record of something
-- that needs a person, and both tables are append-only. It goes into
-- `settlement_creation_quarantine` with the first reason it fails, frozen as
-- `settlement_authority_reconciliation` is (the bounded set this migration found),
-- and `trg_settlement_reversal_not_quarantined` keeps it from backing a reversal; a
-- case already on one can only be rejected. A row reserving an unsettled transaction
-- keeps reserving it, so `settle()` stays refused there by the unique key, which
-- moves no money, until the owner decides. The deploy is not refused: that would
-- leave every new row unguarded over a row that is already there. It says so: a WARNING
-- with the count and the query.
--
-- A foreign key is validated only when no row breaks it, and otherwise stays NOT
-- VALID: every new row is checked either way. `SELECT conname, convalidated FROM
-- pg_constraint` and the quarantine table say which.
--
-- Bounded: the tables are locked in `settle()`'s own write order, so one in flight
-- finishes first and none starts until commit; waited for at most `lock_timeout`.
-- `transaction` too, last, as `settle()` moves it last. A create with a hold writes
-- `transaction` first, so it can lose a deadlock here: it rolls back, nothing moved. The
-- scans are bounded by `statement_timeout` (default 5 s, raised for one run by
-- `RASTA_MIGRATION_STATEMENT_TIMEOUT`).
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

LOCK TABLE "journal", "wallet_hold", "wallet", "commission", "settlement", "transaction"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "settlement_creation_quarantine" (
    "source_table" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "found_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_creation_quarantine_pkey" PRIMARY KEY ("source_table", "row_id"),
    CONSTRAINT "ck_settlement_creation_quarantine_source"
        CHECK ("source_table" IN ('settlement', 'commission')),
    CONSTRAINT "ck_settlement_creation_quarantine_reason"
        CHECK ("reason" IN ('JOURNAL_MISSING', 'JOURNAL_NOT_ITS_OWN', 'JOURNAL_REVERSED',
                            'TRANSACTION_NOT_SETTLED', 'TRANSACTION_DISAGREES', 'LEGS_DISAGREE',
                            'COMMISSION_MISSING', 'SETTLEMENT_MISSING', 'SETTLEMENT_DISAGREES'))
);
CREATE INDEX "ix_settlement_creation_quarantine_transaction"
    ON "settlement_creation_quarantine" ("transaction_id");

INSERT INTO "settlement_creation_quarantine" ("source_table", "row_id", "transaction_id", "reason")
SELECT 'settlement', s."id", s."transaction_id",
       CASE
         WHEN j."id" IS NULL THEN 'JOURNAL_MISSING'
         WHEN j."journal_type" <> 'SETTLEMENT'
              OR j."organization_id" <> s."organization_id"
              OR j."transaction_id" IS DISTINCT FROM s."transaction_id" THEN 'JOURNAL_NOT_ITS_OWN'
         WHEN EXISTS (SELECT 1 FROM "journal" u WHERE u."reverses_id" = j."id") THEN 'JOURNAL_REVERSED'
         WHEN t."status"::text NOT IN ('SETTLED', 'PARTIALLY_REVERSED', 'REVERSED')
           THEN 'TRANSACTION_NOT_SETTLED'
         WHEN s."organization_id" <> s."payer_organization_id"
              OR t."organization_id" <> s."payer_organization_id"
              OR t."counterparty_organization_id" IS DISTINCT FROM s."payee_organization_id"
              OR t."gross_amount_minor" <> s."gross_amount_minor"
              OR t."commission_amount_minor" <> s."commission_amount_minor"
              OR t."currency" <> s."currency" THEN 'TRANSACTION_DISAGREES'
         WHEN NOT EXISTS (SELECT 1 FROM "commission" c WHERE c."transaction_id" = s."transaction_id")
              AND legs.strays = 0 AND legs.debits = 1 AND legs.revenue_legs <= 1 AND legs.payee_legs <= 1
              AND legs.gross = s."gross_amount_minor" AND legs.commission = s."commission_amount_minor"
           THEN 'COMMISSION_MISSING'
         ELSE 'LEGS_DISAGREE'
       END
  FROM "settlement" s
  JOIN "transaction" t ON t."id" = s."transaction_id"
  LEFT JOIN "journal" j ON j."id" = s."journal_id"
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE e."direction" = 'DEBIT') AS debits,
           COALESCE(SUM(e."amount_minor") FILTER (WHERE e."direction" = 'DEBIT'), 0) AS gross,
           COUNT(*) FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE') AS revenue_legs,
           COALESCE(SUM(e."amount_minor") FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE'), 0) AS commission,
           COUNT(*) FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'WALLET') AS payee_legs,
           COUNT(*) FILTER (WHERE NOT (
             e."currency" = s."currency"
             AND ((e."direction" = 'DEBIT' AND a."purpose" IN ('WALLET', 'ESCROW')
                   AND e."organization_id" = s."payer_organization_id")
               OR (e."direction" = 'CREDIT' AND a."purpose" = 'WALLET'
                   AND e."organization_id" = s."payee_organization_id")
               OR (e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE'
                   AND a."account_type" = 'REVENUE')))) AS strays
      FROM "ledger_entry" e
      JOIN "ledger_account" a ON a."id" = e."account_id"
     WHERE e."journal_id" = s."journal_id"
  ) legs ON TRUE
 WHERE j."id" IS NULL
    OR j."journal_type" <> 'SETTLEMENT'
    OR j."organization_id" <> s."organization_id"
    OR j."transaction_id" IS DISTINCT FROM s."transaction_id"
    OR EXISTS (SELECT 1 FROM "journal" u WHERE u."reverses_id" = j."id")
    OR t."status"::text NOT IN ('SETTLED', 'PARTIALLY_REVERSED', 'REVERSED')
    OR s."organization_id" <> s."payer_organization_id"
    OR t."organization_id" <> s."payer_organization_id"
    OR t."counterparty_organization_id" IS DISTINCT FROM s."payee_organization_id"
    OR t."gross_amount_minor" <> s."gross_amount_minor"
    OR t."commission_amount_minor" <> s."commission_amount_minor"
    OR t."currency" <> s."currency"
    OR legs.strays > 0 OR legs.debits <> 1 OR legs.revenue_legs > 1 OR legs.payee_legs > 1
    OR legs.gross <> s."gross_amount_minor"
    OR legs.commission <> s."commission_amount_minor"
    OR NOT EXISTS (SELECT 1 FROM "commission" c WHERE c."transaction_id" = s."transaction_id");

INSERT INTO "settlement_creation_quarantine" ("source_table", "row_id", "transaction_id", "reason")
SELECT 'commission', c."id", c."transaction_id",
       CASE
         WHEN s."id" IS NULL THEN 'SETTLEMENT_MISSING'
         WHEN c."journal_id" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM "journal" j WHERE j."id" = c."journal_id") THEN 'JOURNAL_MISSING'
         ELSE 'SETTLEMENT_DISAGREES'
       END
  FROM "commission" c
  LEFT JOIN "settlement" s ON s."transaction_id" = c."transaction_id"
 WHERE s."id" IS NULL
    OR c."organization_id" <> s."payee_organization_id"
    OR c."gross_amount_minor" <> s."gross_amount_minor"
    OR c."amount_minor" <> s."commission_amount_minor"
    OR c."currency" <> s."currency"
    OR c."journal_id" IS DISTINCT FROM s."journal_id"
    OR (c."journal_id" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "journal" j WHERE j."id" = c."journal_id"));

CREATE OR REPLACE FUNCTION reject_settlement_creation_quarantine_change() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'settlement_creation_quarantine is fixed by its migration: never written again'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_settlement_creation_quarantine_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "settlement_creation_quarantine"
  FOR EACH ROW EXECUTE FUNCTION reject_settlement_creation_quarantine_change();

CREATE TRIGGER "trg_settlement_creation_quarantine_no_truncate"
  BEFORE TRUNCATE ON "settlement_creation_quarantine"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_settlement_creation_quarantine_change();

-- A quarantined settlement or commission backs no reversal; only a rejection moves
-- a case already on one. Nothing writes a case yet (RLG-002-2 opens them).
CREATE OR REPLACE FUNCTION reject_settlement_reversal_of_quarantined() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "settlement_creation_quarantine" q
              WHERE q."transaction_id" = NEW."transaction_id") THEN
    RAISE EXCEPTION 'A settlement that could not be proven when this was migrated backs no reversal'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_not_quarantined';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_settlement_reversal_not_quarantined"
  BEFORE INSERT OR UPDATE ON "settlement_reversal"
  FOR EACH ROW
  WHEN (NEW."status" <> 'REJECTED')
  EXECUTE FUNCTION reject_settlement_reversal_of_quarantined();

ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_journal_id_fkey" FOREIGN KEY ("journal_id")
  REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_journal_id_fkey" FOREIGN KEY ("journal_id")
  REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

-- The one answer to "the holds of this transaction". The payer's: `transaction.organization_id`.
CREATE OR REPLACE FUNCTION transaction_holds(transaction_id TEXT, payer TEXT)
RETURNS SETOF "wallet_hold" AS $$
  SELECT h.*
    FROM "wallet_hold" h
    JOIN "wallet" w ON w."id" = h."wallet_id" AND w."organization_id" = h."organization_id"
   WHERE h."reference" = transaction_id
     AND h."reference_type" = 'TRANSACTION'
     AND h."organization_id" = payer;
$$ LANGUAGE sql STABLE;

-- The triggers run as the writer, and PUBLIC has no EXECUTE on what the migrator
-- creates (service-privilege-split.bash). SECURITY INVOKER, as is everything here.
GRANT EXECUTE ON FUNCTION transaction_holds(TEXT, TEXT) TO rasta_economic;

-- By the rows, not by a quarantine reason: a row keeps only the first it fails.
DO $validate_settlement_creation_proof$
DECLARE
  found BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "settlement" s
                  WHERE NOT EXISTS (SELECT 1 FROM "journal" j WHERE j."id" = s."journal_id")) THEN
    ALTER TABLE "settlement" VALIDATE CONSTRAINT "settlement_journal_id_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "commission" c
                  WHERE c."journal_id" IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM "journal" j WHERE j."id" = c."journal_id")) THEN
    ALTER TABLE "commission" VALIDATE CONSTRAINT "commission_journal_id_fkey";
  END IF;
  SELECT count(*) INTO found FROM "settlement_creation_quarantine";
  IF found > 0 THEN
    RAISE WARNING 'settlement: % row(s) could not be proven and were quarantined; they are left as they are and back no reversal', found
      USING HINT = 'List them with: SELECT * FROM settlement_creation_quarantine; each needs the owner to decide.';
  END IF;
  -- What `trg_wallet_hold_reference_bound` refuses from here on, as one scan of the table.
  SELECT count(*) INTO found
    FROM "wallet_hold" h
    LEFT JOIN "transaction" t ON t."id" = h."reference"
    LEFT JOIN "wallet" w ON w."id" = h."wallet_id"
   WHERE w."organization_id" IS DISTINCT FROM h."organization_id"
      OR (h."reference_type" = 'TRANSACTION' AND t."organization_id" IS DISTINCT FROM h."organization_id")
      OR (h."reference_type" <> 'TRANSACTION' AND t."id" IS NOT NULL);
  IF found > 0 THEN
    RAISE WARNING 'wallet_hold: % row(s) are not bound to their tenant and purpose; no settlement counts them, and they are left as they are', found
      USING HINT = 'TransactionRepository.lockForUpdate and WalletRepository.findActiveHold do not ask transaction_holds: read these rows before settling what they name.';
  END IF;
END
$validate_settlement_creation_proof$;

-- Fixed words in every refusal: no identifier or amount in a message the service logs.
CREATE OR REPLACE FUNCTION assert_settlement_creation_proven() RETURNS TRIGGER AS $$
DECLARE
  own_xid CONSTANT TEXT := (txid_current() % 4294967296)::text;
  settled RECORD;
  charged RECORD;
  obligation RECORD;
  posted RECORD;
  legs RECORD;
  held BOOLEAN;
  subject TEXT;
BEGIN
  IF TG_TABLE_NAME = 'transaction' THEN
    subject := NEW."id";
  ELSE
    subject := NEW."transaction_id";
  END IF;
  SELECT s.*, s.xmin::text AS written_by INTO settled
    FROM "settlement" s WHERE s."transaction_id" = subject;
  SELECT c.*, c.xmin::text AS written_by INTO charged
    FROM "commission" c WHERE c."transaction_id" = subject;
  IF settled."id" IS NULL OR charged."id" IS NULL
     OR settled.written_by <> own_xid OR charged.written_by <> own_xid THEN
    RAISE EXCEPTION 'A settlement and its commission are written together, by one transaction'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_creation_proven';
  END IF;

  SELECT t.*, t.xmin::text AS written_by INTO obligation
    FROM "transaction" t WHERE t."id" = subject;
  IF obligation."status"::text <> 'SETTLED' OR obligation.written_by <> own_xid THEN
    RAISE EXCEPTION 'A settlement is written only by the transaction that moves its transaction to SETTLED'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_creation_proven';
  END IF;
  IF obligation."organization_id" <> settled."organization_id"
     OR settled."payer_organization_id" <> settled."organization_id"
     OR obligation."counterparty_organization_id" IS DISTINCT FROM settled."payee_organization_id" THEN
    RAISE EXCEPTION 'A settlement names exactly the parties of its transaction'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_creation_proven';
  END IF;
  IF obligation."gross_amount_minor" <> settled."gross_amount_minor"
     OR obligation."commission_amount_minor" <> settled."commission_amount_minor"
     OR obligation."currency" <> settled."currency"
     OR obligation."settled_at" IS DISTINCT FROM settled."settled_at" THEN
    RAISE EXCEPTION 'A settlement states exactly the figures of its transaction'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_creation_proven';
  END IF;
  IF charged."organization_id" <> settled."payee_organization_id"
     OR charged."gross_amount_minor" <> settled."gross_amount_minor"
     OR charged."amount_minor" <> settled."commission_amount_minor"
     OR charged."currency" <> settled."currency"
     OR charged."journal_id" IS DISTINCT FROM settled."journal_id"
     OR charged."applied_at" <> settled."settled_at"
     OR charged."business_line" IS DISTINCT FROM obligation."business_line" THEN
    RAISE EXCEPTION 'A commission states exactly what its settlement states'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_creation_proven';
  END IF;

  SELECT j.*, j.xmin::text AS written_by INTO posted
    FROM "journal" j WHERE j."id" = settled."journal_id";
  IF posted.written_by <> own_xid
     OR posted."journal_type" <> 'SETTLEMENT'
     OR posted."organization_id" <> settled."organization_id"
     OR posted."transaction_id" IS DISTINCT FROM settled."transaction_id" THEN
    RAISE EXCEPTION 'A settlement names the SETTLEMENT journal its own transaction posted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_creation_proven';
  END IF;

  -- A leg's organization and currency are its account's (`fk_ledger_entry_account_identity`).
  SELECT COUNT(*) FILTER (WHERE e."direction" = 'DEBIT') AS debits,
         COALESCE(SUM(e."amount_minor") FILTER (WHERE e."direction" = 'DEBIT'), 0) AS gross,
         COUNT(*) FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'WALLET') AS payee_legs,
         COUNT(*) FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE') AS revenue_legs,
         COALESCE(SUM(e."amount_minor") FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE'), 0) AS commission,
         COUNT(*) FILTER (WHERE e."direction" = 'DEBIT' AND a."purpose" = 'ESCROW') AS escrow_legs,
         COUNT(*) FILTER (WHERE NOT (
           e."currency" = settled."currency"
           AND ((e."direction" = 'DEBIT' AND a."purpose" IN ('WALLET', 'ESCROW')
                 AND e."organization_id" = settled."payer_organization_id")
             OR (e."direction" = 'CREDIT' AND a."purpose" = 'WALLET'
                 AND e."organization_id" = settled."payee_organization_id")
             OR (e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE'
                 AND a."account_type" = 'REVENUE')))) AS strays
    INTO legs
    FROM "ledger_entry" e
    JOIN "ledger_account" a ON a."id" = e."account_id"
   WHERE e."journal_id" = settled."journal_id";
  IF legs.strays > 0 OR legs.debits <> 1 OR legs.payee_legs > 1 OR legs.revenue_legs > 1
     OR legs.gross <> settled."gross_amount_minor"
     OR legs.commission <> settled."commission_amount_minor" THEN
    RAISE EXCEPTION 'The legs of a settlement journal are exactly the settlement'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_creation_proven';
  END IF;

  held := EXISTS (
    SELECT 1 FROM transaction_holds(settled."transaction_id", settled."payer_organization_id") h
     WHERE h."status" = 'RELEASED'
       AND h."resolved_journal_id" = settled."journal_id"
       AND h."amount_minor" = settled."gross_amount_minor"
       AND h."currency" = settled."currency");
  IF held <> (legs.escrow_legs = 1)
     OR EXISTS (SELECT 1 FROM transaction_holds(settled."transaction_id", settled."payer_organization_id") h
                 WHERE h."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'A settlement debits escrow exactly when its journal released the hold, and leaves no hold active'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_creation_proven';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_settlement_creation_proven"
  AFTER INSERT ON "settlement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_settlement_creation_proven();

CREATE CONSTRAINT TRIGGER "trg_commission_creation_proven"
  AFTER INSERT ON "commission"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_settlement_creation_proven();

-- A top-up is born SETTLED, with no counterparty and no settlement: no UPDATE, no proof.
CREATE CONSTRAINT TRIGGER "trg_transaction_settled_proven"
  AFTER UPDATE OF "status" ON "transaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."status" = 'SETTLED' AND OLD."status" IS DISTINCT FROM 'SETTLED')
  EXECUTE FUNCTION assert_settlement_creation_proven();

-- In the body, not a WHEN: a WHEN would hold the columns against an older down.sql.
CREATE OR REPLACE FUNCTION reject_transaction_terms_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A recorded obligation is never deleted: nothing else ever answers to its id'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_transaction_terms_fixed';
  END IF;
  IF (OLD."id", OLD."organization_id", OLD."counterparty_organization_id", OLD."business_line",
      OLD."gross_amount_minor", OLD."currency")
     IS DISTINCT FROM
     (NEW."id", NEW."organization_id", NEW."counterparty_organization_id", NEW."business_line",
      NEW."gross_amount_minor", NEW."currency") THEN
    RAISE EXCEPTION 'Who pays whom, how much, in what and on which line never changes, nor the id it answers to'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_transaction_terms_fixed';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Named to run after `trg_transaction_statement_obligation_fixed`, which keeps its own words.
CREATE TRIGGER "trg_transaction_terms_fixed"
  BEFORE UPDATE OR DELETE ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION reject_transaction_terms_change();

-- The statement-level half of the same freeze, for both tables the proof reads.
CREATE OR REPLACE FUNCTION reject_obligation_record_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% records what is owed and held: never emptied', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_transaction_no_truncate"
  BEFORE TRUNCATE ON "transaction"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_obligation_record_truncate();

CREATE TRIGGER "trg_wallet_hold_no_truncate"
  BEFORE TRUNCATE ON "wallet_hold"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_obligation_record_truncate();

-- The wallet's owner and the transaction's identity are what this reads. Neither can
-- change (above and below), so what is true at the insert stays true.
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
  ELSIF EXISTS (SELECT 1 FROM "transaction" t WHERE t."id" = NEW."reference") THEN
    RAISE EXCEPTION 'A hold for anything else names no transaction'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_hold_reference_bound';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_wallet_hold_reference_bound"
  BEFORE INSERT OR UPDATE OR DELETE ON "wallet_hold"
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_hold_reference();

-- `transaction_holds` asks whose wallet a hold is on: moving one would step its holds out.
CREATE OR REPLACE FUNCTION reject_wallet_owner_change() RETURNS TRIGGER AS $$
BEGIN
  IF (OLD."id", OLD."organization_id") IS DISTINCT FROM (NEW."id", NEW."organization_id") THEN
    RAISE EXCEPTION 'A wallet never changes hands'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_wallet_owner_fixed';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_wallet_owner_fixed"
  BEFORE UPDATE ON "wallet"
  FOR EACH ROW EXECUTE FUNCTION reject_wallet_owner_change();

-- 20261103121000's three bodies, each hold predicate asking `transaction_holds`.
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

CREATE OR REPLACE FUNCTION enforce_transaction_settlement_edges() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status"::text = 'SETTLED' AND OLD."status"::text NOT IN ('SETTLED', 'PENDING_SETTLEMENT') THEN
    RAISE EXCEPTION 'A transaction is settled only from PENDING_SETTLEMENT'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_transaction_status_edges';
  END IF;
  IF OLD."status"::text = 'SETTLED'
     AND NEW."status"::text NOT IN ('SETTLED', 'PARTIALLY_REVERSED', 'REVERSED') THEN
    RAISE EXCEPTION 'A settled transaction leaves SETTLED only by its reversal'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_transaction_status_edges';
  END IF;
  IF OLD."status"::text IN ('SETTLED', 'PARTIALLY_REVERSED', 'REVERSED')
     AND (OLD."commission_amount_minor", OLD."net_amount_minor", OLD."settled_at")
         IS DISTINCT FROM
         (NEW."commission_amount_minor", NEW."net_amount_minor", NEW."settled_at") THEN
    RAISE EXCEPTION 'What a transaction settled at never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_transaction_status_edges';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Named to run after `trg_transaction_settlement_authority` and the other older guards,
-- which keep their own words for what they refuse.
CREATE TRIGGER "trg_transaction_status_edges"
  BEFORE UPDATE ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION enforce_transaction_settlement_edges();

-- `trg_commission_append_only` is row-level, so it never answered a TRUNCATE.
CREATE OR REPLACE FUNCTION reject_commission_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'commission is append-only: never emptied'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_commission_no_truncate';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_commission_no_truncate"
  BEFORE TRUNCATE ON "commission"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_commission_truncate();
