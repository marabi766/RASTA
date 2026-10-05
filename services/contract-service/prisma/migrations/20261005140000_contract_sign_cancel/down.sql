-- =============================================================================
-- Reverse of `migration.sql` (CON-003 PR 2).
--
-- Restores `contract_guard` to what the initial migration made it (origin immutable, never
-- erased), drops the signatures, the cancellation columns and the idempotency store, then
-- the enum. Roll the code back first: it reads and writes all of these.
--
-- **This destroys every signature and every cancellation reason recorded.** A contract
-- already SIGNED or CANCELLED stays in that status (the column is not touched), so after
-- this reverse the database holds signed contracts with no signature behind them; the
-- `CONTRACT_SIGNED` and `CONTRACT_CANCELLED` events already published are what remains,
-- and audit-service keeps its own copy of each.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

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
