-- =============================================================================
-- contract-service — `deduction_rule_name_is_canonical` in the form PostgreSQL prints back (FU-308 B).
--
-- 20261104100000 wrote the length bound as `length("candidate") BETWEEN 1 AND 200`. PostgreSQL does
-- not keep a BETWEEN: it keeps `>= 1 AND <= 200` as a pair of its own inside the outer AND, prints
-- the pair in parentheses, and reads its own print back as one AND of six. So a restored database
-- prints this function's body differently from the database it was dumped from. The restore drill
-- refused that until FU-327 taught its SOURCE/REF comparison this one regrouping, for every object
-- alike; it now passes the function and lists it under `foldedBooleanLists`. Written as PostgreSQL
-- prints it, the body is its own round trip: source and restore are equal byte for byte with no
-- rule applied, and the function leaves that list.
--
-- Nothing a name can tell: the same two bounds and the same four patterns, copied byte for byte,
-- joined by the same AND. `test/deduction-rule-change.int-spec.ts` still runs it against the
-- application over every code point, and `test/deduction-rule-name-restore-stable.int-spec.ts` holds
-- it to 20261104100000's over the lengths around both bounds, NULL and every pattern, and to the
-- round trip.
--
-- `CREATE OR REPLACE` with the same signature: the CHECKs that call it, and its GRANT to the runtime
-- role, stay as they are. No row is re-checked, and none needs to be: no answer changes.
-- =============================================================================

CREATE OR REPLACE FUNCTION "deduction_rule_name_is_canonical"("candidate" TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN length("candidate") >= 1
    AND length("candidate") <= 200
    AND "candidate" ~ U&'^[\0020-\007E\00AB\00BB\060C\061B\061F\066A\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC\0654\200C]+$'
    AND "candidate" !~ U&'^[\0020\200C]|[\0020\200C]$|[\0020\200C]{2}'
    AND "candidate" !~ U&'(^|[^\0647])\0654'
    AND "candidate" !~ U&'(^|[^\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC\0654])\200C|\200C($|[^\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC])';
