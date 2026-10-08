-- =============================================================================
-- Reverse of `migration.sql` (CON-003 PR 2).
--
-- Restores `contract_guard` to what the initial migration made it (origin immutable, never
-- erased), drops the signatures, the cancellation columns and the idempotency store, then
-- the enum. Roll the code back first: it reads and writes all of these.
--
-- **Refuses, and changes nothing, once any of this has been used.** A signature is the audit
-- record of who accepted a contract, and a cancellation reason is the record of why it ended;
-- both are immutable, and dropping them would leave contracts that are SIGNED or CANCELLED with
-- nothing behind them. So this script stops, with a message, when any `contract_signature` row
-- exists, any contract is SIGNED or CANCELLED, or any contract carries cancellation data. On a
-- database where signing and cancelling were never used it restores the previous schema
-- exactly (the `idempotency_key` rows are a replay cache, not a record, and are dropped).
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
--
-- The whole file is one transaction (`BEGIN; … COMMIT;`): run with `psql --file` (autocommit by
-- default) the lock would otherwise end before the check and a signature could commit between the
-- check and the drops, and a refusal need not stop the statements after it. Inside it the lock,
-- the check that RAISEs and every change commit together or not at all. Run it with
-- `-v ON_ERROR_STOP=1`; without it a refusal still leaves nothing changed (the transaction aborts).
-- =============================================================================

BEGIN;

-- Locked first, so no signature or cancellation can be written between the check and the drops.
LOCK TABLE "contract_signature", "contract" IN ACCESS EXCLUSIVE MODE;

DO $preflight_sign_cancel$
DECLARE
  signatures integer;
  ended integer;
BEGIN
  SELECT count(*) INTO signatures FROM "contract_signature";
  SELECT count(*) INTO ended FROM "contract"
   WHERE "status" IN ('SIGNED', 'CANCELLED')
      OR "cancel_reason_code" IS NOT NULL OR "cancel_note" IS NOT NULL;
  IF signatures > 0 OR ended > 0 THEN
    RAISE EXCEPTION 'down refused: % signature(s) and % signed or cancelled contract(s) exist; nothing was changed', signatures, ended
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_sign_cancel$;

DROP TABLE IF EXISTS "idempotency_key";

DROP TRIGGER IF EXISTS "tg_contract_signature_no_truncate" ON "contract_signature";
DROP TRIGGER IF EXISTS "tg_contract_signature_immutable" ON "contract_signature";
DROP TRIGGER IF EXISTS "tg_contract_signature_insert" ON "contract_signature";
DROP TABLE IF EXISTS "contract_signature";
DROP FUNCTION IF EXISTS "contract_signature_guard"();

CREATE OR REPLACE FUNCTION "contract_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."tender_id" IS DISTINCT FROM OLD."tender_id"
       OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
       OR NEW."winning_bid_id" IS DISTINCT FROM OLD."winning_bid_id"
       OR NEW."contractor_organization_id" IS DISTINCT FROM OLD."contractor_organization_id"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."matrix_digest" IS DISTINCT FROM OLD."matrix_digest"
       OR NEW."awarded_by" IS DISTINCT FROM OLD."awarded_by"
       OR NEW."awarded_at" IS DISTINCT FROM OLD."awarded_at"
       OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_contract_origin_immutable: what a contract was made from never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_contract_not_erasable: a contract is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "contract" DROP CONSTRAINT IF EXISTS "ck_contract_cancellation";
ALTER TABLE "contract"
  DROP COLUMN IF EXISTS "cancel_note",
  DROP COLUMN IF EXISTS "cancel_reason_code";

DROP TYPE IF EXISTS "ContractSide";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005140000_contract_sign_cancel';

COMMIT;
