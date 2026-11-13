-- =============================================================================
-- Reverse of `migration.sql` (20261109200000_deduction_rule_name_canonical_restore_stable, FU-308 B).
-- Gives back the body of 20261104100000: `BETWEEN 1 AND 200` and the same four patterns. It answers
-- the same for every name, so it refuses nothing; a restore prints the body differently from its
-- source again (the restore drill's fold, FU-327, passes that and lists the function) until this
-- is re-applied.
--
-- Before 20261104100000's own down, never after it: that one drops the function, and this file
-- would then create it again, alone, in a schema that has no rule names left to check.
--
-- The patterns are 20261104100000's code point for code point, spelled E'\u…' where it wrote
-- U&'\…': the rollback path refuses a backslash in any other string (as in 20261108100000's down).
-- PostgreSQL stores and prints the two spellings alike, which the spec and the verifier both hold.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION "deduction_rule_name_is_canonical"("candidate" TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN length("candidate") BETWEEN 1 AND 200
    AND "candidate" ~ E'^[\u0020-\u007E\u00AB\u00BB\u060C\u061B\u061F\u066A\u0621-\u063A\u0641\u0642\u0644-\u0648\u067E\u0686\u0698\u06A9\u06AF\u06CC\u0654\u200C]+$'
    AND "candidate" !~ E'^[\u0020\u200C]|[\u0020\u200C]$|[\u0020\u200C]{2}'
    AND "candidate" !~ E'(^|[^\u0647])\u0654'
    AND "candidate" !~ E'(^|[^\u0621-\u063A\u0641\u0642\u0644-\u0648\u067E\u0686\u0698\u06A9\u06AF\u06CC\u0654])\u200C|\u200C($|[^\u0621-\u063A\u0641\u0642\u0644-\u0648\u067E\u0686\u0698\u06A9\u06AF\u06CC])';

DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261109200000_deduction_rule_name_canonical_restore_stable';

COMMIT;
