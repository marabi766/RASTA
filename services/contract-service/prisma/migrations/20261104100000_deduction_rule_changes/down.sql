-- =============================================================================
-- Reverse of `migration.sql` (20261104100000_deduction_rule_changes, CON-003-1).
--
-- Drops the changes, `deduction_rule.approved_change_id` and the guards that made a rule depend on a
-- change, and restores the previous `deduction_rule_guard`. Roll the code back first.
--
-- **Refuses, and changes nothing, once a change exists.** A change is the record of who proposed and
-- who decided what is withheld from a contractor's pay; without it a rule in force, or a retirement,
-- has no explanation. A rule from before this migration carries no change and loses nothing.
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check that RAISEs and every change commit
-- together or not at all. The `_prisma_migrations` row is removed last so the forward migration can
-- be re-applied.
-- =============================================================================

BEGIN;

-- Locked first, so nothing can be written between the check and the drops.
LOCK TABLE "deduction_rule_change", "deduction_rule" IN ACCESS EXCLUSIVE MODE;

DO $preflight_deduction_rule_changes$
DECLARE
  changes integer;
BEGIN
  SELECT count(*) INTO changes FROM "deduction_rule_change";
  IF changes > 0 THEN
    RAISE EXCEPTION 'down refused: % deduction rule change(s) exist; nothing was changed', changes
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_deduction_rule_changes$;

DROP TRIGGER IF EXISTS "tg_deduction_rule_insert" ON "deduction_rule";
DROP FUNCTION IF EXISTS "deduction_rule_insert_guard"();

CREATE OR REPLACE FUNCTION "deduction_rule_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."name" IS DISTINCT FROM OLD."name"
       OR NEW."rate_bp" IS DISTINCT FROM OLD."rate_bp"
       OR NEW."base" IS DISTINCT FROM OLD."base"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR (OLD."retired_at" IS NOT NULL AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at")
    THEN
      RAISE EXCEPTION 'ck_deduction_rule_immutable: a deduction rule never changes; it is only retired, once'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_deduction_rule_not_erasable: a deduction rule is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS "ux_deduction_rule_name_active";
CREATE UNIQUE INDEX "ux_deduction_rule_name_active" ON "deduction_rule"("organization_id", "name")
  WHERE "retired_at" IS NULL;
ALTER TABLE "deduction_rule" DROP CONSTRAINT IF EXISTS "ck_deduction_rule_name_canonical";

ALTER TABLE "deduction_rule" DROP CONSTRAINT IF EXISTS "deduction_rule_approved_change_fkey";
DROP INDEX IF EXISTS "ux_deduction_rule_approved_change";
ALTER TABLE "deduction_rule" DROP COLUMN IF EXISTS "approved_change_id";

DROP TRIGGER IF EXISTS "tg_deduction_rule_change_effect" ON "deduction_rule_change";
DROP TRIGGER IF EXISTS "tg_deduction_rule_change_no_truncate" ON "deduction_rule_change";
DROP TRIGGER IF EXISTS "tg_deduction_rule_change_guard" ON "deduction_rule_change";
DROP TRIGGER IF EXISTS "tg_deduction_rule_change_insert" ON "deduction_rule_change";
DROP TABLE IF EXISTS "deduction_rule_change";

DROP FUNCTION IF EXISTS "deduction_rule_change_effect"();
DROP FUNCTION IF EXISTS "deduction_rule_change_guard"();
DROP FUNCTION IF EXISTS "deduction_rule_change_insert_guard"();
DROP FUNCTION IF EXISTS "deduction_rule_name_key"(TEXT);
DROP FUNCTION IF EXISTS "deduction_rule_name_is_canonical"(TEXT);

DROP TYPE IF EXISTS "DeductionRuleChangeStatus";
DROP TYPE IF EXISTS "DeductionRuleChangeKind";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104100000_deduction_rule_changes';

COMMIT;
