-- Settlement reversal: the domain and its storage, with no route and no money
-- (RLG-002-1; docs/24 Q-76, PR #543; PM decision D-115). Nothing in this release
-- writes these rows or these statuses: RLG-002-2 opens a case, RLG-002-3 applies
-- one. Every rule that must hold whoever writes them is held here.
--
-- ## The case
--
--   OPEN ──► PROPOSED ──► APPLIED    (the only move that posts money; final)
--    │▲         │  └────► REJECTED   (final)
--    │└─────────┘                    (rejected back for a new proposal)
--    └──────────────────► REJECTED   (nothing to reverse, or nothing left to)
--
-- One case per source (`ux_settlement_reversal_source`). The shape of a row at
-- each status is CHECKed. A proposal is never edited in place, and an approval
-- approves exactly what was proposed. The approver is provably someone else: the
-- same test as `compareActors`, which needs the user id too (so `proposed_by` and
-- `approved_by` are stored beside the issuer and subject). A rejection, final or
-- back to OPEN, names who made it and why, and is never the proposer's; the latest
-- one stays on the row. A case is never deleted, and an update is one version
-- further or it is refused. Bait-and-switch between two proposals is the
-- service's to stop: an approval must name the version its approver read.
--
-- ## The cap (D-115 A: partial reversals, cumulative, never above the settlement)
--
-- Moving a case to PROPOSED or APPLIED locks the transaction row and refuses
-- when applied + this one exceeds the settlement, for gross, for commission and
-- for net. gross = commission + net per row, so when gross is fully reversed the
-- caps force commission and net to be exactly the settlement's: any rounding
-- remainder lands on the last reversal. The lock serialises two approvals, and
-- the sum after it sees what the other committed, which is a property of READ
-- COMMITTED alone: a snapshot older than the lock would read a stale sum, so any
-- other isolation level is refused rather than trusted.
--
-- What it is capped by holds still, whoever writes. A settlement row is append-only
-- from birth, case or no case: `trg_settlement_append_only` refuses every UPDATE and
-- DELETE (and so an upsert or a cascade), `trg_settlement_no_truncate` the rest, and
-- its unique keys refuse a second row. And the row is believed only as far as the
-- ledger agrees: the journal it names must be its transaction's own SETTLEMENT
-- journal, immutable, never reversed, with exactly these parties, figures and
-- currency, and the transaction must say the same, or nothing is proposed or
-- applied. So a row added beside a SETTLED transaction with none, a top-up say,
-- caps nothing: a top-up has no counterparty to be its payee.
--
-- ## The transaction follows the money, in both directions
--
-- `trg_transaction_reversal_status`: a transaction is PARTIALLY_REVERSED while
-- 0 < Σ applied gross < settlement gross and REVERSED at Σ = gross, and it leaves
-- neither for anything else. `trg_settlement_reversal_status_moved` (at commit):
-- an applied case whose transaction did not follow does not commit. So the
-- journal comes first, then the case, then the transaction.
--
-- ## The journal
--
-- An applied case names a SETTLEMENT_REVERSAL journal of its own transaction and
-- books, and its legs are the reversal, checked when the case names it:
--
--   CREDIT  the payer's WALLET        gross
--   DEBIT   the account the settlement credited as revenue   commission
--   DEBIT   the payee's WALLET        net   (the journal balances at commit)
--
-- The revenue account is named by id, from the settlement's own journal: a purpose
-- label proves nothing about whose it is. The wallets are named by organization,
-- purpose and currency, which is one account (the unique key on the three). And what all of
-- it reads stays put: `trg_ledger_account_identity_fixed` freezes an account's id,
-- organization, type, purpose and currency from birth, and a foreign key refuses to
-- delete one that carries an entry, so no account is relabelled, not even for a
-- moment inside one transaction.
--
-- `trg_ledger_entry_settlement_reversal_closed` then refuses any further leg on it,
-- or on a journal a settlement names, so what was checked is what commits. RLG-002-3 adds the receivable leg of D-115 B
-- here when it adds the account: until then a leg of any other shape is refused.
-- `trg_journal_settlement_reversal_owned` (at commit) is the other direction: no
-- SETTLEMENT_REVERSAL journal exists without the applied case that names it. And
-- `trg_journal_settlement_reversal_final` refuses a ledger reversal of one, or of a
-- SETTLEMENT journal: that would give the money back beside any case.
--
-- ## Refused rather than decided
--
-- A contract statement's obligation (source_type STATEMENT) cannot have a case.
-- contract-service holds the statement and the contract SETTLED on it
-- (ADR-068 § 6), and nobody has decided what reversing one means for them.
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction but the new value
-- cannot be used in it, so everything below names them through `::text`, as
-- 20261017160000_statement_settlement does. Fixed words in every refusal: no
-- identifier or amount in a message the service logs.
SET LOCAL lock_timeout = '3s';

ALTER TYPE "TransactionStatus" ADD VALUE 'PARTIALLY_REVERSED';
ALTER TYPE "TransactionStatus" ADD VALUE 'REVERSED';
ALTER TYPE "JournalType" ADD VALUE 'SETTLEMENT_REVERSAL';

CREATE TYPE "SettlementReversalSource" AS ENUM ('RETURN_REQUEST', 'MANUAL');
CREATE TYPE "SettlementReversalStatus" AS ENUM ('OPEN', 'PROPOSED', 'APPLIED', 'REJECTED');

CREATE TABLE "settlement_reversal" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "source_type" "SettlementReversalSource" NOT NULL,
    "source_reference" TEXT NOT NULL,
    "status" "SettlementReversalStatus" NOT NULL DEFAULT 'OPEN',
    "gross_minor" BIGINT,
    "commission_minor" BIGINT,
    "net_minor" BIGINT,
    "reason" TEXT,
    "evidence_reference" TEXT,
    "proposed_by" TEXT,
    "proposed_by_issuer" TEXT,
    "proposed_by_subject" TEXT,
    "proposed_at" TIMESTAMPTZ(3),
    "approved_by" TEXT,
    "approved_by_issuer" TEXT,
    "approved_by_subject" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "rejected_by" TEXT,
    "rejected_by_issuer" TEXT,
    "rejected_by_subject" TEXT,
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "journal_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "settlement_reversal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlement_reversal_transaction_id_fkey" FOREIGN KEY ("transaction_id")
        REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "settlement_reversal_settlement_id_fkey" FOREIGN KEY ("settlement_id")
        REFERENCES "settlement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "settlement_reversal_journal_id_fkey" FOREIGN KEY ("journal_id")
        REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ck_settlement_reversal_id" CHECK ("id" ~ '^SRV_[0-9A-Z]{26}$'),
    CONSTRAINT "ck_settlement_reversal_source_reference"
        CHECK ("source_reference" ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,127}$'),
    -- Commission and net may be zero: no commission was charged, or a small part
    -- reversal rounds entirely to one side. Gross never is.
    CONSTRAINT "ck_settlement_reversal_amounts"
        CHECK ("gross_minor" > 0 AND "commission_minor" >= 0 AND "net_minor" >= 0
           AND "gross_minor" = "commission_minor" + "net_minor"),
    -- All or nothing: none while OPEN, all while PROPOSED or APPLIED, and either
    -- once REJECTED, since a case may be rejected before anything was proposed.
    CONSTRAINT "ck_settlement_reversal_proposal"
        CHECK (num_nonnulls("gross_minor", "commission_minor", "net_minor", "reason",
                            "evidence_reference", "proposed_by", "proposed_by_issuer",
                            "proposed_by_subject", "proposed_at") IN (0, 9)
           AND ("status" <> 'OPEN' OR "proposed_by" IS NULL)
           AND ("status" NOT IN ('PROPOSED', 'APPLIED') OR "proposed_by" IS NOT NULL)),
    CONSTRAINT "ck_settlement_reversal_approval"
        CHECK (num_nonnulls("approved_by", "approved_by_issuer", "approved_by_subject",
                            "approved_at", "journal_id")
               = CASE WHEN "status" = 'APPLIED' THEN 5 ELSE 0 END),
    -- The latest rejection, all or nothing, and always one on a REJECTED case.
    CONSTRAINT "ck_settlement_reversal_rejection"
        CHECK (num_nonnulls("rejected_by", "rejected_by_issuer", "rejected_by_subject",
                            "rejected_at", "rejection_reason") IN (0, 5)
           AND ("status" <> 'REJECTED' OR "rejected_by" IS NOT NULL)),
    CONSTRAINT "ck_settlement_reversal_text"
        CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500
           AND "evidence_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$'
           AND char_length(btrim("rejection_reason")) BETWEEN 3 AND 500
           AND btrim("proposed_by") <> '' AND btrim("proposed_by_issuer") <> ''
           AND btrim("proposed_by_subject") <> ''
           AND btrim("approved_by") <> '' AND btrim("approved_by_issuer") <> ''
           AND btrim("approved_by_subject") <> ''
           AND btrim("rejected_by") <> '' AND btrim("rejected_by_issuer") <> ''
           AND btrim("rejected_by_subject") <> ''),
    -- `compareActors`' DISTINCT: same issuer, and neither id names the other
    -- person. Anything it would call UNKNOWN is refused for an approval, which
    -- moves money.
    CONSTRAINT "ck_settlement_reversal_four_eyes"
        CHECK ("status" <> 'APPLIED'
            OR ("approved_by_issuer" = "proposed_by_issuer"
            AND "approved_by_subject" <> "proposed_by_subject"
            AND "approved_by" <> "proposed_by"
            AND "approved_by" <> "proposed_by_subject"
            AND "proposed_by" <> "approved_by_subject"))
);

-- The idempotency of a case. Across tenants on purpose: a source is one fact.
CREATE UNIQUE INDEX "ux_settlement_reversal_source"
    ON "settlement_reversal" ("source_type", "source_reference");
-- One journal backs one reversal.
CREATE UNIQUE INDEX "ux_settlement_reversal_journal" ON "settlement_reversal" ("journal_id");
CREATE INDEX "ix_settlement_reversal_org_status"
    ON "settlement_reversal" ("organization_id", "status", "created_at" DESC);
-- The sum the triggers read under the transaction lock.
CREATE INDEX "ix_settlement_reversal_transaction" ON "settlement_reversal" ("transaction_id");

CREATE OR REPLACE FUNCTION enforce_settlement_reversal_change() RETURNS TRIGGER AS $$
DECLARE
  settled RECORD;
  applied RECORD;
  obligation RECORD;
  origin RECORD;
  posted RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'A settlement reversal is opened OPEN, at version 1'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM "transaction" t
        JOIN "settlement" s ON s."transaction_id" = t."id"
       WHERE t."id" = NEW."transaction_id"
         AND s."id" = NEW."settlement_id"
         AND t."organization_id" = NEW."organization_id"
         AND s."organization_id" = NEW."organization_id"
         AND t."status"::text IN ('SETTLED', 'PARTIALLY_REVERSED')
         AND t."source_type" IS DISTINCT FROM 'STATEMENT') THEN
      RAISE EXCEPTION 'A settlement reversal opens only on the payer''s settled transaction, against its settlement'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('APPLIED', 'REJECTED') THEN
    RAISE EXCEPTION 'A settlement reversal is final once applied or rejected'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
  END IF;
  IF (OLD."id", OLD."organization_id", OLD."transaction_id", OLD."settlement_id",
      OLD."source_type", OLD."source_reference", OLD."created_at")
     IS DISTINCT FROM
     (NEW."id", NEW."organization_id", NEW."transaction_id", NEW."settlement_id",
      NEW."source_type", NEW."source_reference", NEW."created_at") THEN
    RAISE EXCEPTION 'What a settlement reversal is about never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
  END IF;
  IF NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('PROPOSED', 'REJECTED'))
       OR (OLD."status" = 'PROPOSED' AND NEW."status" IN ('APPLIED', 'REJECTED', 'OPEN'))) THEN
    RAISE EXCEPTION 'A settlement reversal moves OPEN to PROPOSED or REJECTED, and PROPOSED to APPLIED, REJECTED or OPEN'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'A settlement reversal moves exactly one version at a time'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
  END IF;
  IF NEW."status" IN ('APPLIED', 'REJECTED')
     AND (OLD."gross_minor", OLD."commission_minor", OLD."net_minor", OLD."reason",
          OLD."evidence_reference", OLD."proposed_by", OLD."proposed_by_issuer",
          OLD."proposed_by_subject", OLD."proposed_at")
         IS DISTINCT FROM
         (NEW."gross_minor", NEW."commission_minor", NEW."net_minor", NEW."reason",
          NEW."evidence_reference", NEW."proposed_by", NEW."proposed_by_issuer",
          NEW."proposed_by_subject", NEW."proposed_at") THEN
    RAISE EXCEPTION 'A decision on a settlement reversal is about exactly what was proposed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
  END IF;
  -- A rejection moves nothing and needs no proof of two people, as in
  -- `payment-reconciliation.operator.ts`; only the proposer is refused. A NULL
  -- comparison here means nothing was proposed: there is no proposer to be.
  IF NEW."status" = 'REJECTED' OR NEW."status" = 'OPEN' THEN
    IF NEW."rejected_by" IS NULL
       OR NEW."rejected_at" IS NOT DISTINCT FROM OLD."rejected_at"
       OR NEW."rejected_by" = OLD."proposed_by"
       OR NEW."rejected_by" = OLD."proposed_by_subject"
       OR OLD."proposed_by" = NEW."rejected_by_subject"
       OR (NEW."rejected_by_issuer" = OLD."proposed_by_issuer"
           AND NEW."rejected_by_subject" = OLD."proposed_by_subject") THEN
      RAISE EXCEPTION 'A settlement reversal is rejected by someone named, who is not its proposer'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD."rejected_by", OLD."rejected_by_issuer", OLD."rejected_by_subject",
      OLD."rejected_at", OLD."rejection_reason")
     IS DISTINCT FROM
     (NEW."rejected_by", NEW."rejected_by_issuer", NEW."rejected_by_subject",
      NEW."rejected_at", NEW."rejection_reason") THEN
    RAISE EXCEPTION 'Only a rejection writes the record of a rejection'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_guard';
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'A settlement reversal is proposed or applied only under READ COMMITTED'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_cap';
  END IF;
  SELECT "gross_amount_minor", "commission_amount_minor", "currency",
         "organization_id", "counterparty_organization_id"
    INTO obligation FROM "transaction" WHERE "id" = NEW."transaction_id" FOR UPDATE;

  SELECT "gross_amount_minor", "commission_amount_minor", "net_amount_minor", "currency",
         "payer_organization_id", "payee_organization_id", "journal_id"
    INTO settled FROM "settlement" WHERE "id" = NEW."settlement_id";
  -- bool_and skips a NULL, so nothing inside it may be able to be one: every column
  -- here is NOT NULL, and no rows at all leave `shaped` NULL, which is refused. Net
  -- needs no comparison: `ck_settlement_amounts` and a balanced journal imply it.
  SELECT COALESCE(SUM(e."amount_minor") FILTER (WHERE e."direction" = 'DEBIT'), 0) AS gross,
         COALESCE(SUM(e."amount_minor") FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE'), 0)
           AS commission,
         COUNT(*) FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE') AS revenue_legs,
         MIN(e."account_id") FILTER (WHERE e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE')
           AS revenue_account,
         bool_and(e."currency" = settled."currency"
                  AND ((e."direction" = 'DEBIT' AND a."purpose" IN ('WALLET', 'ESCROW')
                        AND e."organization_id" = settled."payer_organization_id")
                    OR (e."direction" = 'CREDIT' AND a."purpose" = 'WALLET'
                        AND e."organization_id" = settled."payee_organization_id")
                    OR (e."direction" = 'CREDIT' AND a."purpose" = 'COMMISSION_REVENUE'
                        AND a."account_type" = 'REVENUE')))
           AS shaped
    INTO origin
    FROM "journal" j
    JOIN "ledger_entry" e ON e."journal_id" = j."id"
    JOIN "ledger_account" a ON a."id" = e."account_id"
   WHERE j."id" = settled."journal_id"
     AND j."journal_type" = 'SETTLEMENT'
     AND j."organization_id" = NEW."organization_id"
     AND j."transaction_id" = NEW."transaction_id";
  IF origin.shaped IS NOT TRUE OR origin.revenue_legs > 1
     OR origin.gross <> settled."gross_amount_minor"
     OR origin.commission <> settled."commission_amount_minor"
     OR obligation."gross_amount_minor" <> settled."gross_amount_minor"
     OR obligation."commission_amount_minor" <> settled."commission_amount_minor"
     OR obligation."currency" <> settled."currency"
     OR obligation."organization_id" <> settled."payer_organization_id"
     OR obligation."counterparty_organization_id" IS DISTINCT FROM settled."payee_organization_id"
     OR EXISTS (SELECT 1 FROM "journal" u WHERE u."reverses_id" = settled."journal_id") THEN
    RAISE EXCEPTION 'A settlement reversal is measured only against a settlement its own journal bears out'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_cap';
  END IF;
  SELECT COALESCE(SUM("gross_minor"), 0) AS gross,
         COALESCE(SUM("commission_minor"), 0) AS commission,
         COALESCE(SUM("net_minor"), 0) AS net
    INTO applied FROM "settlement_reversal"
   WHERE "transaction_id" = NEW."transaction_id" AND "status" = 'APPLIED';
  IF applied.gross + NEW."gross_minor" > settled."gross_amount_minor"
     OR applied.commission + NEW."commission_minor" > settled."commission_amount_minor"
     OR applied.net + NEW."net_minor" > settled."net_amount_minor" THEN
    RAISE EXCEPTION 'A settlement is never reversed beyond what it settled'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_cap';
  END IF;

  IF NEW."status" = 'APPLIED' THEN
    SELECT COALESCE(SUM(e."amount_minor") FILTER (WHERE e."direction" = 'CREDIT'), 0) AS credited,
           COALESCE(SUM(e."amount_minor") FILTER (WHERE e."account_id" = origin.revenue_account), 0)
             AS commission,
           bool_and(e."currency" = settled."currency"
                    AND ((e."direction" = 'CREDIT' AND a."purpose" = 'WALLET'
                          AND e."organization_id" = settled."payer_organization_id")
                      OR (e."direction" = 'DEBIT' AND a."purpose" = 'WALLET'
                          AND e."organization_id" = settled."payee_organization_id")
                      OR (e."direction" = 'DEBIT'
                          AND e."account_id" IS NOT DISTINCT FROM origin.revenue_account)))
             AS shaped
      INTO posted
      FROM "journal" j
      JOIN "ledger_entry" e ON e."journal_id" = j."id"
      JOIN "ledger_account" a ON a."id" = e."account_id"
     WHERE j."id" = NEW."journal_id"
       AND j."journal_type"::text = 'SETTLEMENT_REVERSAL'
       AND j."organization_id" = NEW."organization_id"
       AND j."transaction_id" = NEW."transaction_id";
    IF posted.credited <> NEW."gross_minor" OR posted.commission <> NEW."commission_minor"
       OR posted.shaped IS NOT TRUE THEN
      RAISE EXCEPTION 'An applied settlement reversal names its own journal, whose legs are the reversal'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_journal';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_settlement_reversal_guard"
  BEFORE INSERT OR UPDATE ON "settlement_reversal"
  FOR EACH ROW EXECUTE FUNCTION enforce_settlement_reversal_change();

CREATE OR REPLACE FUNCTION reject_settlement_reversal_removal() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'A settlement reversal is never removed'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_settlement_reversal_no_delete"
  BEFORE DELETE ON "settlement_reversal"
  FOR EACH ROW EXECUTE FUNCTION reject_settlement_reversal_removal();

CREATE TRIGGER "trg_settlement_reversal_no_truncate"
  BEFORE TRUNCATE ON "settlement_reversal"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_settlement_reversal_removal();

CREATE OR REPLACE FUNCTION assert_settlement_reversal_status_moved() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "transaction" t
      JOIN "settlement" s ON s."id" = NEW."settlement_id"
     WHERE t."id" = NEW."transaction_id"
       AND t."status"::text = CASE
             WHEN (SELECT SUM(r."gross_minor") FROM "settlement_reversal" r
                    WHERE r."transaction_id" = t."id" AND r."status" = 'APPLIED')
                  = s."gross_amount_minor"
             THEN 'REVERSED' ELSE 'PARTIALLY_REVERSED' END) THEN
    RAISE EXCEPTION 'An applied settlement reversal moves its transaction with it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_settlement_reversal_status_moved';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_settlement_reversal_status_moved"
  AFTER UPDATE ON "settlement_reversal"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."status" = 'APPLIED')
  EXECUTE FUNCTION assert_settlement_reversal_status_moved();

CREATE OR REPLACE FUNCTION enforce_transaction_reversal_status() RETURNS TRIGGER AS $$
DECLARE
  settled_gross BIGINT;
  reversed NUMERIC;
BEGIN
  IF NEW."status"::text NOT IN ('PARTIALLY_REVERSED', 'REVERSED') THEN
    IF TG_OP = 'UPDATE' AND OLD."status"::text IN ('PARTIALLY_REVERSED', 'REVERSED') THEN
      RAISE EXCEPTION 'A reversed transaction never leaves its reversal'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_transaction_reversal_status';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR OLD."status"::text NOT IN ('SETTLED', 'PARTIALLY_REVERSED', 'REVERSED') THEN
    RAISE EXCEPTION 'Only a settled transaction is reversed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_transaction_reversal_status';
  END IF;
  SELECT "gross_amount_minor" INTO settled_gross FROM "settlement" WHERE "transaction_id" = OLD."id";
  SELECT SUM("gross_minor") INTO reversed FROM "settlement_reversal"
   WHERE "transaction_id" = OLD."id" AND "status" = 'APPLIED';
  IF reversed IS NULL OR settled_gross IS NULL
     OR NEW."status"::text <> (CASE WHEN reversed = settled_gross THEN 'REVERSED'
                                    ELSE 'PARTIALLY_REVERSED' END) THEN
    RAISE EXCEPTION 'A transaction is reversed as far as its applied reversals say'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_transaction_reversal_status';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_transaction_reversal_status"
  BEFORE INSERT OR UPDATE OF "status" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION enforce_transaction_reversal_status();

CREATE OR REPLACE FUNCTION assert_settlement_reversal_journal_owned() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "settlement_reversal" r
     WHERE r."journal_id" = NEW."id" AND r."status" = 'APPLIED') THEN
    RAISE EXCEPTION 'A settlement reversal journal exists only for the applied reversal that names it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_journal_settlement_reversal_owned';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_journal_settlement_reversal_owned"
  AFTER INSERT ON "journal"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."journal_type"::text = 'SETTLEMENT_REVERSAL')
  EXECUTE FUNCTION assert_settlement_reversal_journal_owned();

CREATE OR REPLACE FUNCTION reject_settlement_reversal_journal_leg() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "settlement_reversal" r WHERE r."journal_id" = NEW."journal_id")
     OR EXISTS (SELECT 1 FROM "settlement" s WHERE s."journal_id" = NEW."journal_id") THEN
    RAISE EXCEPTION 'A journal takes no leg once a settlement or its reversal names it'
      USING ERRCODE = 'restrict_violation',
            CONSTRAINT = 'trg_ledger_entry_settlement_reversal_closed';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_ledger_entry_settlement_reversal_closed"
  BEFORE INSERT ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION reject_settlement_reversal_journal_leg();

CREATE OR REPLACE FUNCTION reject_settlement_reversal_journal_undo() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "journal" j
              WHERE j."id" = NEW."reverses_id"
                AND j."journal_type"::text IN ('SETTLEMENT', 'SETTLEMENT_REVERSAL')) THEN
    RAISE EXCEPTION 'A settlement moves back only by a settlement reversal, which is final: no ledger reversal undoes either'
      USING ERRCODE = 'restrict_violation',
            CONSTRAINT = 'trg_journal_settlement_reversal_final';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_journal_settlement_reversal_final"
  BEFORE INSERT ON "journal"
  FOR EACH ROW
  WHEN (NEW."reverses_id" IS NOT NULL)
  EXECUTE FUNCTION reject_settlement_reversal_journal_undo();

CREATE OR REPLACE FUNCTION reject_settlement_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'A settlement is append-only: never changed, removed or replaced'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_settlement_append_only';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_settlement_append_only"
  BEFORE UPDATE OR DELETE ON "settlement"
  FOR EACH ROW EXECUTE FUNCTION reject_settlement_mutation();

CREATE TRIGGER "trg_settlement_no_truncate"
  BEFORE TRUNCATE ON "settlement"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_settlement_mutation();

-- From birth, not from the first entry: nothing in this service ever updates these
-- (`ensureAccount`: first writer wins, an existing account is never mutated), and an
-- empty account relabelled before its first entry would carry that label into it.
-- `status` and `title` are not what an account is.
CREATE OR REPLACE FUNCTION reject_ledger_account_identity_change() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'What a ledger account is never changes'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'trg_ledger_account_identity_fixed';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_ledger_account_identity_fixed"
  BEFORE UPDATE ON "ledger_account"
  FOR EACH ROW
  WHEN ((OLD."id", OLD."organization_id", OLD."account_type", OLD."purpose", OLD."currency")
        IS DISTINCT FROM
        (NEW."id", NEW."organization_id", NEW."account_type", NEW."purpose", NEW."currency"))
  EXECUTE FUNCTION reject_ledger_account_identity_change();

-- What ck_transaction_amounts and ck_transaction_settled_at hold of a SETTLED row
-- stays true of one that was reversed. NOT VALID because no existing row can hold
-- these statuses: nothing to scan, and every write is checked.
ALTER TABLE "transaction"
  ADD CONSTRAINT "ck_transaction_reversed_settled"
  CHECK ("status"::text NOT IN ('PARTIALLY_REVERSED', 'REVERSED')
      OR ("settled_at" IS NOT NULL
      AND "net_amount_minor" = "gross_amount_minor" - "commission_amount_minor"))
  NOT VALID;
