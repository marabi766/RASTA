-- =============================================================================
-- contract-service — what makes two rule names one name (FU-083, PM decision on #677 question 2).
--
-- `Tax` and `TAX`, or a space and a half-space, could both stand in force and both cut the same pay.
-- The key now folds case and drops every space and half-space, in `deduction_rule_name_key` here and
-- `deductionRuleNameKey` in `src/deduction/deduction-rule-name.ts`. A half-space already counted as
-- nothing (#677 r1 F1), so a space equal to a half-space counts as nothing too: `Tax A` and `TaxA` are
-- one name. What is stored and shown stays as typed.
--
-- `translate`, not `lower`: `lower` follows the database's collation, and an index must not. Nothing is
-- lost: the one form admits no cased letter but A-Z, and `deduction-rule-name.spec.ts` holds Unicode's
-- own case mapping to this key over every code point, so widening the form fails that test.
--
-- An index holds what its function returned, so both are dropped and rebuilt around the replacement.
-- **Two rules in force, or two pending CREATEs, of one new key stop this migration with nothing
-- changed**, for a person to decide: `docs/runbooks/deduction-rule-name-collisions.md`. A retired rule
-- or a decided change is outside both indexes and stops nothing. Nothing changed holds because
-- `prisma migrate deploy` runs this file as one transaction; do not run it bare with `psql --file`.
-- =============================================================================

DROP INDEX "ux_deduction_rule_change_pending_create";
DROP INDEX "ux_deduction_rule_name_active";

CREATE OR REPLACE FUNCTION "deduction_rule_name_key"("canonical_name" TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN translate("canonical_name", U&'ABCDEFGHIJKLMNOPQRSTUVWXYZ\0020\200C', 'abcdefghijklmnopqrstuvwxyz');

CREATE UNIQUE INDEX "ux_deduction_rule_change_pending_create"
  ON "deduction_rule_change"("organization_id", "deduction_rule_name_key"("name"))
  WHERE "status" = 'PENDING_APPROVAL' AND "kind" = 'CREATE';
CREATE UNIQUE INDEX "ux_deduction_rule_name_active"
  ON "deduction_rule"("organization_id", "deduction_rule_name_key"("name"))
  WHERE "retired_at" IS NULL;
