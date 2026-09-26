-- Reverses 20260926000000_asset_ownership_generation.
--
-- Roll the code back first: it reads and writes these columns. The previous
-- code judged ownership by timestamps, which are untouched.
--
-- Refused when that loses information (PR #108 round 3 #2). Up derives a
-- generation from timestamps; a policy recorded in the same millisecond as a
-- transfer, just before it, is stored as the previous owner's but would be
-- derived as the new owner's, and with a narrowed coverage configuration the
-- new owner could then rely on it. So before dropping anything, every stored
-- generation is compared with the one up would derive, and any difference
-- stops the rollback, lists the rows, and changes nothing. Those rows need an
-- operator's decision, not a rollback.
--
-- Locks asset first, ACCESS EXCLUSIVE, as the migration and the application
-- do (round 3 #1): the reverse order deadlocked with a writer holding an
-- asset row FOR SHARE.

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "asset", "insurance_policy", "asset_transfer" IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  lost text[];
BEGIN
  SELECT array_agg(format('asset %s: stored %s, derived %s', a."id", a."ownership_generation", t.n)
                   ORDER BY a."id")
    INTO lost
    FROM "asset" a
    CROSS JOIN LATERAL (SELECT count(*)::integer AS n FROM "asset_transfer" x
                         WHERE x."asset_id" = a."id") t
   WHERE a."ownership_generation" <> t.n;

  SELECT coalesce(lost, '{}') || coalesce(array_agg(
           format('insurance_policy %s: stored %s, derived %s', p."id", p."ownership_generation", t.n)
           ORDER BY p."id"), '{}')
    INTO lost
    FROM "insurance_policy" p
    CROSS JOIN LATERAL (SELECT count(*)::integer AS n FROM "asset_transfer" x
                         WHERE x."asset_id" = p."asset_id" AND x."transferred_at" <= p."created_at") t
   WHERE p."ownership_generation" <> t.n;

  IF cardinality(lost) > 0 THEN
    RAISE EXCEPTION 'ownership_generation cannot be re-derived from timestamps for % row(s); nothing was rolled back: %',
      cardinality(lost), array_to_string(lost, '; ')
      USING ERRCODE = 'check_violation';
  END IF;
END
$preflight$;

ALTER TABLE "insurance_policy" DROP COLUMN IF EXISTS "ownership_generation";
ALTER TABLE "asset" DROP COLUMN IF EXISTS "ownership_generation";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260926000000_asset_ownership_generation';

COMMIT;
