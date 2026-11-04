-- A resolved dispute returns a transaction to where its settlement authority
-- stands, never further (marketplace audit F1, PM decision D-083).
--
-- A resolution used to move every DISPUTED transaction to PENDING_SETTLEMENT.
-- An order's obligation disputed before its buyer confirmed receipt is HELD
-- with no settlement authorisation, and the resolution made it
-- settlement-ready all the same: authorisation without the fact that
-- authorises it. The rule now (`resolvedStatus`,
-- src/transaction/state-machine.ts), decided from the row as it stands under
-- the resolution's lock:
--
--   settlement_authorised_at set                -> PENDING_SETTLEMENT
--   an ACTIVE hold, no authorisation recorded   -> HELD
--   no ACTIVE hold                              -> PENDING_SETTLEMENT
--
-- Every fact is already on the row or its hold; nothing is backfilled and no
-- row is written here. An authorised transaction never returns to HELD, so
-- that is where its dispute found it. A DISPUTED row with no active hold was
-- never HELD (a hold is released only by settling or refunding, both
-- terminal): an ADR-032 obligation, authorised when recorded. An escrowed row
-- with no recorded authorisation goes back to HELD, which also covers the two
-- rows nothing can tell apart — one an older release resolved to
-- PENDING_SETTLEMENT without an authorisation, and one authorised before
-- 20260926120000 recorded the instant: either then needs an authorisation
-- before it can settle, which is the side to err on with money.
--
-- Enforced here as well as in the service, so a pod of the previous release
-- still resolving during the rollout cannot send an escrowed, unauthorised
-- transaction to the settlement queue: the write is refused (check_violation)
-- and the command fails with nothing changed; its retry, on a current pod,
-- succeeds.
--
-- And `assign_transaction_resolved_dispute` (20261022120000) learns the new
-- exit: DISPUTED -> HELD is a resolution too, and records the dispute it
-- decided exactly as DISPUTED -> PENDING_SETTLEMENT does. Its rule for rows
-- resolved before that migration is unchanged — those were all resolved to
-- PENDING_SETTLEMENT.
--
-- Catalogue changes only: two functions and one trigger, no column and no
-- row. The table's lock is held for milliseconds, waited for at most
-- `lock_timeout`; `statement_timeout` (default 5 s, raised for one run by
-- `RASTA_MIGRATION_STATEMENT_TIMEOUT`) bounds the rest.
SET LOCAL lock_timeout = '3s';
SELECT set_config('statement_timeout',
                  COALESCE(NULLIF(current_setting('rasta.migration_statement_timeout', true), ''), '5s'),
                  true);

CREATE OR REPLACE FUNCTION assign_transaction_resolved_dispute() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."resolved_dispute_id" := NULL;
  ELSIF OLD."status" = 'DISPUTED' AND NEW."status" IN ('PENDING_SETTLEMENT', 'HELD') THEN
    NEW."resolved_dispute_id" := OLD."dispute_id";
  ELSIF OLD."resolved_dispute_id" IS NULL
        AND OLD."status" IN ('PENDING_SETTLEMENT', 'SETTLED')
        AND OLD."disputed_at" IS NOT NULL
        AND OLD."dispute_resolved_at" IS NOT NULL THEN
    -- Resolved before 20261022120000: its latest dispute's.
    NEW."resolved_dispute_id" := OLD."dispute_id";
  ELSE
    NEW."resolved_dispute_id" := OLD."resolved_dispute_id";
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

CREATE TRIGGER "trg_transaction_dispute_resolution"
  BEFORE UPDATE OF "status" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION enforce_transaction_dispute_resolution();
