-- Reverses 20261012120000_insurance_pending_verification (#240 round 8).
--
-- Roll the code back first: the asset-sync consumer parks into this table and
-- its sweep reads it. A parked row is an INSURANCE_RECORDED whose delivery was
-- marked processed and that has not been applied: dropping the table loses it.
-- Dead-letter them first, or note their event ids and replay them once the code
-- is rolled back (docs/runbooks/insurance-reprojection.md). The refusal below
-- keeps the rollback from discarding them silently.
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('public.insurance_pending_verification') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "insurance_pending_verification") THEN
    RAISE EXCEPTION 'insurance_pending_verification still holds parked INSURANCE_RECORDED events; '
      'dead-letter or replay them before rolling back (#240 r8)';
  END IF;
END $$;

DROP TABLE IF EXISTS "insurance_pending_verification";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261012120000_insurance_pending_verification';

COMMIT;
