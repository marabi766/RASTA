-- =============================================================================
-- Reverse of `migration.sql` (the refusal code of a bid read).
--
-- **Refused while any row holds a refusal code.** The code is the only record, outside
-- construction-service's own log, of why a read was refused (a conflict of interest, say);
-- dropping the column would destroy it. Locks the table first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "bid_access_evidence" IN ACCESS EXCLUSIVE MODE;

DO $preflight_refusal$
DECLARE
  coded bigint;
BEGIN
  SELECT count(*) INTO coded FROM "bid_access_evidence" WHERE "refusal_code" IS NOT NULL;
  IF coded > 0 THEN
    RAISE EXCEPTION 'down refused: % bid access row(s) hold a refusal code; dropping the column would destroy why those reads were refused. Keep this migration.', coded
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_refusal$;

ALTER TABLE "bid_access_evidence" DROP CONSTRAINT IF EXISTS "ck_bid_access_evidence_refusal_code";
ALTER TABLE "bid_access_evidence" DROP COLUMN IF EXISTS "refusal_code";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261002160000_bid_access_refusal_code';

COMMIT;
