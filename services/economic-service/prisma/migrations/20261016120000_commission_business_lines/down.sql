-- =============================================================================
-- Reverse of `migration.sql` (20261016120000_commission_business_lines).
--
-- Refuses while ANY row carries a business line — a transaction, a rule or a
-- commission. The schema before this migration cannot say what those rows
-- say: a line-wide rule has no type to fall back to, and a transaction that
-- lost its line would be repriced by the type-only rules (ADR-045 Compliance:
-- no retroactive effect). A rollback is therefore possible on any database
-- that never used business lines — including one full of transactions,
-- type-only rules and commissions, which keep exactly what they had.
--
-- `outcome` is dropped without refusal: it is derived from `rule_id`, which
-- stays, and the forward migration derives it again.
--
-- One transaction, the table locks first: a row being written is either
-- counted, so the rollback refuses, or waits and then fails.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE transactions BIGINT;
DECLARE rules BIGINT;
DECLARE commissions BIGINT;
BEGIN
  LOCK TABLE "transaction", "commission_rule", "commission" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO transactions FROM "transaction" WHERE "business_line" IS NOT NULL;
  SELECT count(*) INTO rules FROM "commission_rule" WHERE "business_line" IS NOT NULL;
  SELECT count(*) INTO commissions FROM "commission" WHERE "business_line" IS NOT NULL;
  IF transactions > 0 OR rules > 0 OR commissions > 0 THEN
    RAISE EXCEPTION '% transaction(s), % rule(s) and % commission(s) carry a business line; refusing to roll back beneath them',
      transactions, rules, commissions
      USING HINT = 'The earlier schema would reprice them or lose their rule (docs/23 D-057).';
  END IF;
END
$$;

-- The pricing recorded with an unsettled obligation goes with its columns. Its
-- rule is a type-only one (a line rule was refused above), which the earlier
-- engine finds again at settlement from the same rules.
DROP TRIGGER IF EXISTS "trg_transaction_pricing_fixed" ON "transaction";
DROP FUNCTION IF EXISTS reject_transaction_repricing();
DROP INDEX IF EXISTS "transaction_pricing_rule_id_idx";
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_pricing_rule_id_fkey";
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "ck_transaction_pricing";
ALTER TABLE "transaction" DROP COLUMN IF EXISTS "pricing_rule_id", DROP COLUMN IF EXISTS "pricing_outcome";

DROP TRIGGER IF EXISTS "trg_commission_pricing_cutover_fixed" ON "commission_pricing_cutover";
DROP FUNCTION IF EXISTS reject_commission_pricing_cutover_mutation();
DROP TABLE IF EXISTS "commission_pricing_cutover";

DROP TRIGGER IF EXISTS "trg_commission_rule_effective_dated" ON "commission_rule";
DROP FUNCTION IF EXISTS commission_rule_effective_dated();
ALTER TABLE "commission_rule" DROP CONSTRAINT IF EXISTS "ex_commission_rule_line_type_no_overlap";
ALTER TABLE "commission_rule" DROP CONSTRAINT IF EXISTS "ex_commission_rule_line_no_overlap";
ALTER TABLE "commission_rule" DROP CONSTRAINT IF EXISTS "ex_commission_rule_type_only_no_overlap";
ALTER TABLE "commission_rule" DROP CONSTRAINT IF EXISTS "ck_commission_rule_organization_not_blank";
-- btree_gist stays: the bootstrap installs it into every database, so this
-- migration may not have been the one that added it (as organization-service).

DROP TRIGGER IF EXISTS "trg_commission_append_only" ON "commission";
DROP FUNCTION IF EXISTS reject_commission_mutation();

ALTER TABLE "commission" DROP CONSTRAINT IF EXISTS "commission_rule_id_fkey";
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_rule_id_fkey" FOREIGN KEY ("rule_id")
  REFERENCES "commission_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX IF EXISTS "commission_organization_id_business_line_outcome_idx";
ALTER TABLE "commission" DROP CONSTRAINT IF EXISTS "ck_commission_outcome";
ALTER TABLE "commission" DROP COLUMN IF EXISTS "outcome", DROP COLUMN IF EXISTS "business_line";

DROP INDEX IF EXISTS "commission_rule_business_line_status_valid_from_idx";
ALTER TABLE "commission_rule" DROP CONSTRAINT IF EXISTS "ck_commission_rule_scope";
-- Every rule left names a type: the preflight refused any that named a line,
-- and the scope CHECK refused any that named neither.
ALTER TABLE "commission_rule"
  ALTER COLUMN "transaction_type" SET NOT NULL,
  DROP COLUMN IF EXISTS "business_line";

ALTER TABLE "transaction" DROP COLUMN IF EXISTS "business_line";

DROP TYPE IF EXISTS "CommissionOutcome";
DROP TYPE IF EXISTS "BusinessLine";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016120000_commission_business_lines';

COMMIT;
