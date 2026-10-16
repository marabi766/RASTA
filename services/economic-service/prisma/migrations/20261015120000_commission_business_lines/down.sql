-- =============================================================================
-- Reverse of `migration.sql` (20261015120000_commission_business_lines).
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

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015120000_commission_business_lines';

COMMIT;
