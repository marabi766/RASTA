-- Reverse of `migration.sql` (20261105120000_settlement_creation_proof).
--
-- Drops the proofs, the two foreign keys, the transaction's and the hold's guards, the guard on
-- a reversal and the quarantine, and gives the three older hold predicates back. Refuses nothing: no row is touched, and the quarantine holds nothing
-- that is not still on the rows themselves, which the next up finds again.
-- Rows written after this runs are not proven by anything until it is applied again.
BEGIN;

SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

LOCK TABLE "journal", "wallet_hold", "wallet", "commission", "settlement", "transaction", "settlement_reversal"
  IN SHARE ROW EXCLUSIVE MODE;

-- 20261103121000's three bodies, byte for byte.
CREATE OR REPLACE FUNCTION enforce_transaction_settlement_authority() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."settlement_authorised_at" IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "settlement_authority_reconciliation" r
        WHERE r."transaction_id" = OLD."id" AND r."outcome" = 'AUTHORISED_UNRECORDED')
     AND EXISTS (
       SELECT 1 FROM "wallet_hold" h
        WHERE h."reference" = OLD."id" AND h."reference_type" = 'TRANSACTION') THEN
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
    SELECT 1 FROM "transaction" t
     WHERE t."id" = OLD."reference"
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
  ELSIF EXISTS (
    SELECT 1
      FROM "wallet_hold"
     WHERE "wallet_hold"."reference" = OLD."id"
       AND "wallet_hold"."reference_type" = 'TRANSACTION'
       AND "wallet_hold"."status" = 'ACTIVE'
  ) THEN
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

DROP TRIGGER "trg_wallet_owner_fixed" ON "wallet";
DROP FUNCTION reject_wallet_owner_change();
DROP TRIGGER "trg_wallet_hold_reference_bound" ON "wallet_hold";
DROP FUNCTION enforce_wallet_hold_reference();
DROP TRIGGER "trg_wallet_hold_no_truncate" ON "wallet_hold";
DROP TRIGGER "trg_transaction_no_truncate" ON "transaction";
DROP FUNCTION reject_obligation_record_truncate();

DROP TRIGGER "trg_transaction_status_edges" ON "transaction";
DROP FUNCTION enforce_transaction_settlement_edges();
DROP TRIGGER "trg_transaction_terms_fixed" ON "transaction";
DROP FUNCTION reject_transaction_terms_change();
DROP TRIGGER "trg_transaction_settled_proven" ON "transaction";

DROP TRIGGER "trg_commission_no_truncate" ON "commission";
DROP FUNCTION reject_commission_truncate();
DROP TRIGGER "trg_commission_creation_proven" ON "commission";
DROP TRIGGER "trg_settlement_creation_proven" ON "settlement";
DROP FUNCTION assert_settlement_creation_proven();
DROP FUNCTION transaction_holds(TEXT, TEXT);
ALTER TABLE "commission" DROP CONSTRAINT "commission_journal_id_fkey";
ALTER TABLE "settlement" DROP CONSTRAINT "settlement_journal_id_fkey";
DROP TRIGGER "trg_settlement_reversal_not_quarantined" ON "settlement_reversal";
DROP FUNCTION reject_settlement_reversal_of_quarantined();
DROP TABLE "settlement_creation_quarantine";
DROP FUNCTION reject_settlement_creation_quarantine_change();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105120000_settlement_creation_proof';

COMMIT;
