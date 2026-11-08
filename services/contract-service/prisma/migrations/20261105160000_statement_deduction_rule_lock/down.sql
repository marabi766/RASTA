-- Removes only the FU-089 lock backstop; existing statements/snapshots are unchanged.
BEGIN;
DROP TRIGGER "tg_statement_deduction_00_lock_rule" ON "statement_deduction";
DROP FUNCTION "statement_deduction_lock_rule"();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105160000_statement_deduction_rule_lock';
COMMIT;
