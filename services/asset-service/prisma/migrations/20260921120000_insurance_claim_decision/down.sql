-- Reverses 20260921120000_insurance_claim_decision.
--
-- Roll the code back first: the claim service writes every column dropped
-- here, and a running service against the reverted schema fails on the first
-- decision. Data in these columns is lost by design — a rollback that keeps
-- the columns is not a rollback.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "insurance_claim_asset_id_incident_at_idx";

ALTER TABLE "insurance_claim" DROP CONSTRAINT IF EXISTS "ck_claim_rejected_has_no_approved_amount";
ALTER TABLE "insurance_claim" DROP CONSTRAINT IF EXISTS "ck_claim_settled_iff_settlement_recorded";
ALTER TABLE "insurance_claim" DROP CONSTRAINT IF EXISTS "ck_claim_decided_iff_decision_recorded";

ALTER TABLE "insurance_claim" DROP COLUMN IF EXISTS "settlement_reference";
ALTER TABLE "insurance_claim" DROP COLUMN IF EXISTS "settled_at";
ALTER TABLE "insurance_claim" DROP COLUMN IF EXISTS "decision_notes";
ALTER TABLE "insurance_claim" DROP COLUMN IF EXISTS "decided_by";
ALTER TABLE "insurance_claim" DROP COLUMN IF EXISTS "decided_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260921120000_insurance_claim_decision';
