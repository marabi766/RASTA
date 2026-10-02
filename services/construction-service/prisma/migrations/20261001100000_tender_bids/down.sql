-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 6).
--
-- Drops the triggers and functions, the three tables (indexes, CHECKs and the
-- tenant-bound foreign keys go with them) and the enum.
--
-- **Refused while any bid, receipt or access-log row exists.** A bid is a bidder's
-- sealed submission and its receipt, and the log is the record of who read what:
-- none can be recreated, and the receipt chain is evidence kept elsewhere
-- (audit-service) that a rollback here would orphan. Locks the tender first (as the
-- application does), then the three tables, ACCESS EXCLUSIVE; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender", "bid", "bid_receipt", "bid_access_log" IN ACCESS EXCLUSIVE MODE;

DO $preflight_bids$
DECLARE
  bids bigint;
  receipts bigint;
  reads bigint;
BEGIN
  SELECT count(*) INTO bids FROM "bid";
  SELECT count(*) INTO receipts FROM "bid_receipt";
  SELECT count(*) INTO reads FROM "bid_access_log";
  IF bids + receipts + reads > 0 THEN
    RAISE EXCEPTION 'down refused: % bid(s), % receipt(s) and % access-log row(s) exist. They cannot be recreated and the receipts are evidence a rollback would orphan. Keep this migration, or archive them and decide by hand.', bids, receipts, reads
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_bids$;

DROP TRIGGER IF EXISTS "tg_bid_guard" ON "bid";
DROP FUNCTION IF EXISTS "bid_guard"();

DROP TRIGGER IF EXISTS "tg_bid_receipt_append_only" ON "bid_receipt";
DROP TRIGGER IF EXISTS "tg_bid_receipt_no_truncate" ON "bid_receipt";
DROP TRIGGER IF EXISTS "tg_bid_access_log_append_only" ON "bid_access_log";
DROP TRIGGER IF EXISTS "tg_bid_access_log_no_truncate" ON "bid_access_log";
DROP FUNCTION IF EXISTS "bid_append_only"();

DROP TABLE IF EXISTS "bid_access_log";
DROP TABLE IF EXISTS "bid_receipt";
DROP TABLE IF EXISTS "bid";

DROP TYPE IF EXISTS "BidStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261001100000_tender_bids';

COMMIT;
