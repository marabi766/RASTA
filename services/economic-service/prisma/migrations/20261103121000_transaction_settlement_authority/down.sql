-- Reverse of `migration.sql` (20261103121000_transaction_settlement_authority).
--
-- Puts every RETURNED_TO_HELD row that is still HELD, still holds its funds
-- and is still unauthorised back to PENDING_SETTLEMENT, where it was; a row
-- that has moved on since (authorised, refunded, disputed) keeps its state.
-- Then drops both settlement-authority triggers and the reconciliation table,
-- and gives `enforce_transaction_dispute_resolution` back its 20261103120000
-- body. Run with the previous release deployed. Bounded as `migration.sql` is.
BEGIN;

SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

DROP TRIGGER IF EXISTS "trg_transaction_settlement_authority" ON "transaction";
DROP TRIGGER IF EXISTS "trg_wallet_hold_release_settlement_authority" ON "wallet_hold";
DROP FUNCTION IF EXISTS enforce_transaction_settlement_authority();
DROP FUNCTION IF EXISTS enforce_hold_release_settlement_authority();

UPDATE "transaction" t
   SET "status" = 'PENDING_SETTLEMENT', "updated_at" = CURRENT_TIMESTAMP
  FROM "settlement_authority_reconciliation" r
 WHERE r."transaction_id" = t."id"
   AND r."outcome" = 'RETURNED_TO_HELD'
   AND t."status" = 'HELD'
   AND t."settlement_authorised_at" IS NULL
   AND EXISTS (
     SELECT 1 FROM "wallet_hold" h
      WHERE h."reference" = t."id" AND h."reference_type" = 'TRANSACTION' AND h."status" = 'ACTIVE');

DROP TABLE IF EXISTS "settlement_authority_reconciliation";
DROP FUNCTION IF EXISTS reject_settlement_authority_reconciliation_change();

CREATE OR REPLACE FUNCTION enforce_transaction_dispute_resolution() RETURNS TRIGGER AS $$
DECLARE
  supported TEXT;
BEGIN
  IF OLD."status" <> 'DISPUTED' OR NEW."status" NOT IN ('PENDING_SETTLEMENT', 'HELD') THEN
    RETURN NEW;
  END IF;
  IF OLD."settlement_authorised_at" IS NOT NULL THEN
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
    -- Fixed words: no identifier or amount in the message the service logs.
    RAISE EXCEPTION 'A resolved dispute returns a transaction to where its settlement authority stands'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'trg_transaction_dispute_resolution';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103121000_transaction_settlement_authority';

COMMIT;
