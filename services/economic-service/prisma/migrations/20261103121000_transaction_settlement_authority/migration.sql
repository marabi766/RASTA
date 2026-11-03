-- Settlement needs settlement authority, enforced where the money moves
-- (marketplace audit F1, D-083; review of #623 round 1, F1).
--
-- 20261103120000 stops a resolution from making an escrowed, never-authorised
-- transaction settlement-ready. Rows an earlier release already resolved that
-- way stayed payable: PENDING_SETTLEMENT, an ACTIVE hold, no
-- `settlement_authorised_at`, and settlement checked only the status. The rule
-- is now one predicate, checked by settlement itself (`assertSettlementReady`,
-- src/transaction/state-machine.ts) and here:
--
--   a transaction may settle  ⇔  its settlement was authorised
--                                 or nothing was ever held for it
--
-- "Authorised" is `settlement_authorised_at`, or a row of
-- `settlement_authority_reconciliation` with outcome AUTHORISED_UNRECORDED
-- (below). Everything else with a hold is refused.
--
-- ## The triggers (both BEFORE, so a refusal rolls back the whole settlement)
--
-- - `trg_wallet_hold_release_settlement_authority`: an escrow hold
--   (reference_type TRANSACTION) is RELEASED to the payee only for an
--   authorised transaction. The money-moving step itself; a missing
--   transaction is refused too.
-- - `trg_transaction_settlement_authority`: an unauthorised transaction with
--   any hold, whatever its status, never becomes SETTLED. Any status, because
--   settlement releases the hold before it moves the transaction: by then the
--   hold is RELEASED, not ACTIVE.
--
-- And `enforce_transaction_dispute_resolution` (20261103120000) counts the
-- same authority, so the service and the database agree on where a dispute of
-- an AUTHORISED_UNRECORDED row resolves to (PENDING_SETTLEMENT).
--
-- ## Legacy reconciliation, once, here
--
-- Affected: PENDING_SETTLEMENT, an ACTIVE hold, no `settlement_authorised_at`.
-- Every edge into PENDING_SETTLEMENT is AUTHORISE_SETTLEMENT (which records
-- the instant since 20260926120000) or a resolution (DISPUTED, whose raise
-- always wrote `disputed_at`, 20260828202043). So:
--
-- - `disputed_at` NULL: never disputed, so the only way in was an
--   authorisation given before 20260926120000 recorded its instant. Proven
--   authorised: kept PENDING_SETTLEMENT, recorded AUTHORISED_UNRECORDED.
--   No instant is invented for `settlement_authorised_at`.
-- - `disputed_at` set: in via a resolution, which an earlier release made
--   without regard to authority. Not proven: moved to HELD, recorded
--   RETURNED_TO_HELD. Settling it needs an authorisation now — for an order,
--   its buyer's receipt confirmation, which the order saga sends. An
--   authorisation given before 20260926120000 and then disputed is in this
--   set too; nothing on the row tells it apart, and refusing is the side to
--   err on with money.
--
-- The table is filled here and then frozen (`trg_settlement_authority_
-- reconciliation_frozen`): no later INSERT, UPDATE, DELETE or TRUNCATE, so it
-- is the bounded set this migration found and never a way to authorise a new
-- row. No outbox row: the status read by marketplace is economic's own, at the
-- saga's next call, and this table is the record of who moved and why.
-- `down.sql` puts RETURNED_TO_HELD rows that are still HELD back.
--
-- Bounded: the triggers on "transaction" are created first, so its lock is
-- held from there to commit and no transaction moves while the rows are
-- chosen; waited for at most `lock_timeout`. `statement_timeout` (default
-- 5 s, raised for one run by `RASTA_MIGRATION_STATEMENT_TIMEOUT`) bounds the
-- scan of PENDING_SETTLEMENT rows.
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

CREATE TABLE "settlement_authority_reconciliation" (
    "transaction_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reconciled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_authority_reconciliation_pkey" PRIMARY KEY ("transaction_id"),
    CONSTRAINT "settlement_authority_reconciliation_transaction_id_fkey" FOREIGN KEY ("transaction_id")
        REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ck_settlement_authority_reconciliation_outcome"
        CHECK ("outcome" IN ('AUTHORISED_UNRECORDED', 'RETURNED_TO_HELD'))
);

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

CREATE TRIGGER "trg_transaction_settlement_authority"
  BEFORE UPDATE OF "status" ON "transaction"
  FOR EACH ROW
  WHEN (NEW."status" = 'SETTLED' AND OLD."status" IS DISTINCT FROM 'SETTLED')
  EXECUTE FUNCTION enforce_transaction_settlement_authority();

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

CREATE TRIGGER "trg_wallet_hold_release_settlement_authority"
  BEFORE UPDATE OF "status" ON "wallet_hold"
  FOR EACH ROW
  WHEN (OLD."status" = 'ACTIVE' AND NEW."status" = 'RELEASED' AND OLD."reference_type" = 'TRANSACTION')
  EXECUTE FUNCTION enforce_hold_release_settlement_authority();

-- 20261103120000's body, with the recorded legacy authority counted.
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

-- The legacy rows, chosen under the lock the triggers above took.
INSERT INTO "settlement_authority_reconciliation" ("transaction_id", "outcome")
SELECT t."id",
       CASE WHEN t."disputed_at" IS NULL THEN 'AUTHORISED_UNRECORDED' ELSE 'RETURNED_TO_HELD' END
  FROM "transaction" t
 WHERE t."status" = 'PENDING_SETTLEMENT'
   AND t."settlement_authorised_at" IS NULL
   AND EXISTS (
     SELECT 1 FROM "wallet_hold" h
      WHERE h."reference" = t."id" AND h."reference_type" = 'TRANSACTION' AND h."status" = 'ACTIVE')
ON CONFLICT ("transaction_id") DO NOTHING;

UPDATE "transaction" t
   SET "status" = 'HELD', "updated_at" = CURRENT_TIMESTAMP
  FROM "settlement_authority_reconciliation" r
 WHERE r."transaction_id" = t."id"
   AND r."outcome" = 'RETURNED_TO_HELD'
   AND t."status" = 'PENDING_SETTLEMENT';

CREATE OR REPLACE FUNCTION reject_settlement_authority_reconciliation_change() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'settlement_authority_reconciliation is fixed by its migration: never written again'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_settlement_authority_reconciliation_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "settlement_authority_reconciliation"
  FOR EACH ROW EXECUTE FUNCTION reject_settlement_authority_reconciliation_change();

CREATE TRIGGER "trg_settlement_authority_reconciliation_no_truncate"
  BEFORE TRUNCATE ON "settlement_authority_reconciliation"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_settlement_authority_reconciliation_change();
