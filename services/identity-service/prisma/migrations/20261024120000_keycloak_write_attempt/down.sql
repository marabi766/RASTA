-- Reverses 20261024120000_keycloak_write_attempt.
--
-- Refuses while any fence is outstanding (D-069): each row is a Keycloak write
-- that may still land, or one whose account went missing and is waiting for an
-- operator. Dropping them would silently let a narrowing change run ahead of a
-- write that can overtake it. Lock before checking, so no writer can insert
-- one between the check and the drop; the file runner applies this atomically.
-- To roll back: stop EVERY identity-service replica (no new fences), wait
-- until every fence is past takeover (the last deadline +
-- KEYCLOAK_WRITE_SETTLE_SECONDS), run keycloak:backfill — it projects every
-- fence owner, linked to an account or not, and reports COUNT(*) of this
-- table as fences.outstanding — resolve any terminal fence left (runbook
-- keycloak-projection.md), and run this only once it reports 0.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "keycloak_write_attempt" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "keycloak_write_attempt") THEN
    RAISE EXCEPTION 'keycloak_write_attempt holds outstanding Keycloak write fences; rollback refused';
  END IF;
END;
$$;

DROP TABLE IF EXISTS "keycloak_write_attempt";

-- The expiry sweep's retry state is scheduling only: losing it means a failing
-- lapse is tried sooner, never that one is skipped.
ALTER TABLE "membership" DROP COLUMN IF EXISTS "lapse_retry_at";
ALTER TABLE "membership" DROP COLUMN IF EXISTS "lapse_failures";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024120000_keycloak_write_attempt';
