-- The identity of a transaction's dispute (Codex on #318 round 2, N1; docs/23
-- D-053).
--
-- A transaction holds one dispute at a time, but over its life it can hold
-- several: disputed, resolved, disputed again. `resolve-dispute` resolved
-- whichever one it found, so a decision taken about one dispute could clear
-- another raised since — the order saga's operator decides dispute A, and
-- economic-service, which by then holds B, releases B. `dispute_id` names the
-- dispute; a resolution that names it is applied only while the transaction
-- still holds that dispute, checked under the row lock.
--
-- Assigned here, not by the service: the trigger gives every move into
-- DISPUTED a new identity and keeps it on any other write, whatever the
-- UPDATE sets. A pod of the previous release still running while this
-- migration has been applied disputes without knowing the column, and its
-- dispute must not inherit the identity of the one before it.
--
-- Populated databases: a nullable column with no default, then one UPDATE of
-- the rows ever disputed, so the latest dispute of each has an identity — an
-- open one too, which a saga may already be waiting on. Rows never disputed
-- stay NULL. The trigger is created after the backfill, which it would
-- otherwise undo.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction" ADD COLUMN IF NOT EXISTS "dispute_id" TEXT;

UPDATE "transaction"
   SET "dispute_id" = 'TXD_' || gen_random_uuid()::text
 WHERE "disputed_at" IS NOT NULL
   AND "dispute_id" IS NULL;

CREATE OR REPLACE FUNCTION assign_transaction_dispute_identity() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" = 'DISPUTED'
     AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'DISPUTED') THEN
    NEW."dispute_id" := 'TXD_' || gen_random_uuid()::text;
  ELSIF TG_OP = 'INSERT' THEN
    NEW."dispute_id" := NULL;
  ELSE
    NEW."dispute_id" := OLD."dispute_id";
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_transaction_dispute_identity"
  BEFORE INSERT OR UPDATE OF "status", "dispute_id" ON "transaction"
  FOR EACH ROW EXECUTE FUNCTION assign_transaction_dispute_identity();
