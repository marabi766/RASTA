-- =============================================================================
-- Reverse of `migration.sql` (20261015120000_statements, CON-003 PR 4).
--
-- Drops the statements with their lines and deductions, the deduction rules, and the enum. Roll
-- the code back first: it reads and writes all of these.
--
-- **Refuses, and changes nothing, once any of this has been used.** A statement is the record of
-- what a contractor claimed against a contract and of who submitted it, and a deduction rule is
-- configuration a statement may have applied; dropping either would leave a claim, or the amount
-- withheld from it, that no record explains. So this script stops, with a message, when any
-- statement, line, deduction or deduction rule exists. On a database where none of it was used it
-- restores the previous schema exactly.
--
-- One transaction (`BEGIN; … COMMIT;`): the lock, the check that RAISEs and every change commit
-- together or not at all — run with `psql --file` or `-c`, with `ON_ERROR_STOP` or without it (a
-- refusal aborts the transaction either way). The `_prisma_migrations` row is removed last so the
-- forward migration can be re-applied.
-- =============================================================================

BEGIN;

-- Locked first, so nothing can be written between the check and the drops.
LOCK TABLE "statement_deduction", "statement_line", "statement", "deduction_rule"
  IN ACCESS EXCLUSIVE MODE;

DO $preflight_statements$
DECLARE
  statements integer;
  lines integer;
  deductions integer;
  rules integer;
BEGIN
  SELECT count(*) INTO statements FROM "statement";
  SELECT count(*) INTO lines FROM "statement_line";
  SELECT count(*) INTO deductions FROM "statement_deduction";
  SELECT count(*) INTO rules FROM "deduction_rule";
  IF statements > 0 OR lines > 0 OR deductions > 0 OR rules > 0 THEN
    RAISE EXCEPTION 'down refused: % statement(s), % statement line(s), % statement deduction(s) and % deduction rule(s) exist; nothing was changed', statements, lines, deductions, rules
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight_statements$;

DROP TRIGGER IF EXISTS "tg_statement_deduction_totals_consistent" ON "statement_deduction";
DROP TRIGGER IF EXISTS "tg_statement_deduction_no_truncate" ON "statement_deduction";
DROP TRIGGER IF EXISTS "tg_statement_deduction_guard" ON "statement_deduction";
DROP TABLE IF EXISTS "statement_deduction";

DROP TRIGGER IF EXISTS "tg_statement_line_totals_consistent" ON "statement_line";
DROP TRIGGER IF EXISTS "tg_statement_line_no_truncate" ON "statement_line";
DROP TRIGGER IF EXISTS "tg_statement_line_guard" ON "statement_line";
DROP TABLE IF EXISTS "statement_line";

DROP TRIGGER IF EXISTS "tg_statement_totals_consistent" ON "statement";
DROP TRIGGER IF EXISTS "tg_statement_no_truncate" ON "statement";
DROP TRIGGER IF EXISTS "tg_statement_guard" ON "statement";
DROP TABLE IF EXISTS "statement";

DROP FUNCTION IF EXISTS "statement_totals_consistent"();
DROP FUNCTION IF EXISTS "statement_part_guard"();
DROP FUNCTION IF EXISTS "statement_guard"();

DROP TRIGGER IF EXISTS "tg_deduction_rule_no_truncate" ON "deduction_rule";
DROP TRIGGER IF EXISTS "tg_deduction_rule_guard" ON "deduction_rule";
DROP TABLE IF EXISTS "deduction_rule";
DROP FUNCTION IF EXISTS "deduction_rule_guard"();

DROP TYPE IF EXISTS "StatementStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015120000_statements';

COMMIT;
