-- =============================================================================
-- Reverse of `migration.sql` (20261108100000_deduction_rule_name_fold, FU-083). Restores the key of
-- 20261104100000. That key is finer, so what is unique under this one stays unique: it refuses nothing.
-- =============================================================================

BEGIN;

DROP INDEX "ux_deduction_rule_change_pending_create";
DROP INDEX "ux_deduction_rule_name_active";

CREATE OR REPLACE FUNCTION "deduction_rule_name_key"("canonical_name" TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN replace("canonical_name", E'\u200C', '');

CREATE UNIQUE INDEX "ux_deduction_rule_change_pending_create"
  ON "deduction_rule_change"("organization_id", "deduction_rule_name_key"("name"))
  WHERE "status" = 'PENDING_APPROVAL' AND "kind" = 'CREATE';
CREATE UNIQUE INDEX "ux_deduction_rule_name_active"
  ON "deduction_rule"("organization_id", "deduction_rule_name_key"("name"))
  WHERE "retired_at" IS NULL;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108100000_deduction_rule_name_fold';

COMMIT;
