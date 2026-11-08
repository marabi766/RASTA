-- Reverses 20261107130000_order_hold_deadline_backfill, and only while it has recorded
-- nothing: once a deadline was given, its record stays as long as the deadline may (on the
-- order, or revoked: either way the evidence of it), so the rollback is refused. Locked first,
-- so no backfill can record one between the check and the drop.
SET LOCAL lock_timeout = '3s';
LOCK TABLE "order_hold_deadline_backfill", "order_hold_deadline_revocation" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "order_hold_deadline_backfill") THEN
    RAISE EXCEPTION 'ck_order_hold_deadline_audit_kept: the backfill gave deadlines; its record is not dropped'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
DROP TABLE "order_hold_deadline_revocation";
DROP TABLE "order_hold_deadline_backfill";
DROP FUNCTION "order_hold_deadline_audit_guard"();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261107130000_order_hold_deadline_backfill';
