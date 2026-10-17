-- A transaction's source key, taken off it and kept apart (review of #334
-- round 2, F3).
--
-- 20261017130000_transaction_recorded_source refuses to apply while a row
-- claims a reserved source type its owner did not record. The correction its
-- HINT named first — rename the row's source_type to <type>_UNCONFIRMED — is
-- itself a key any caller could have taken: a tenant holding both ORDER/R and
-- ORDER_UNCONFIRMED/R (both valid before) could not be corrected, because the
-- rename collided with the second row under ux_transaction_source_fact, and
-- cancelling or refunding the first does not free its key.
--
-- So the key leaves the row instead of moving within it. This migration comes
-- before the one that refuses, and is applied before it refuses:
--
-- - transaction_source_quarantine keeps the key the row had — organization,
--   source type, source reference — with the recorded decision behind taking
--   it, who took it and when. Append-only: one row per transaction, never
--   changed, never deleted.
-- - quarantine_transaction_source(id, decision) writes that row and clears the
--   transaction's source_type and source_reference, in one statement. Nothing
--   else on the transaction changes: its id, payer, payee, amount, status,
--   legs, ledger journals, idempotency key and history stay as they are.
--   ux_transaction_source_fact covers only rows with both fields set, so the
--   cleared row holds no key — it cannot collide with anything, whatever
--   other rows exist.
--
-- An operator's tool, not the service's: only the migrator (the owner) runs
-- it. The role split's default privileges already withhold EXECUTE on the
-- migrator's functions from PUBLIC (service-privilege-split.bash); the REVOKE
-- below says so here too, for a database provisioned without them.
CREATE TABLE "transaction_source_quarantine" (
    "transaction_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "quarantined_by" TEXT NOT NULL,
    "quarantined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_source_quarantine_pkey" PRIMARY KEY ("transaction_id"),
    CONSTRAINT "transaction_source_quarantine_transaction_id_fkey" FOREIGN KEY ("transaction_id")
        REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ck_transaction_source_quarantine_decision"
        CHECK (char_length(btrim("decision")) BETWEEN 10 AND 500)
);

CREATE OR REPLACE FUNCTION reject_transaction_source_quarantine_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'transaction_source_quarantine is append-only: never UPDATE or DELETE'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_transaction_source_quarantine_append_only"
  BEFORE UPDATE OR DELETE ON "transaction_source_quarantine"
  FOR EACH ROW EXECUTE FUNCTION reject_transaction_source_quarantine_mutation();

CREATE TRIGGER "trg_transaction_source_quarantine_no_truncate"
  BEFORE TRUNCATE ON "transaction_source_quarantine"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_transaction_source_quarantine_mutation();

CREATE OR REPLACE FUNCTION quarantine_transaction_source(p_transaction_id TEXT, p_decision TEXT)
RETURNS VOID AS $$
DECLARE
  keyed RECORD;
BEGIN
  SELECT "id", "organization_id", "source_type", "source_reference"
    INTO keyed
    FROM "transaction"
   WHERE "id" = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction %: no such transaction', p_transaction_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF keyed."source_type" IS NULL OR keyed."source_reference" IS NULL THEN
    RAISE EXCEPTION 'transaction %: holds no source key to quarantine', p_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO "transaction_source_quarantine"
    ("transaction_id", "organization_id", "source_type", "source_reference", "decision",
     "quarantined_by")
  VALUES
    (keyed."id", keyed."organization_id", keyed."source_type", keyed."source_reference",
     btrim(p_decision), session_user);

  UPDATE "transaction"
     SET "source_type" = NULL, "source_reference" = NULL
   WHERE "id" = keyed."id";
END; $$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION quarantine_transaction_source(TEXT, TEXT) FROM PUBLIC;
