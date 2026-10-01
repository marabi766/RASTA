-- =============================================================================
-- Reverse of `migration.sql` (the tender-evidence projection).
--
-- **Refused while any evidence exists.** The receipt chain held here is the
-- externally kept head bids are opened against, and the access rows are the record
-- of who read which bid: neither can be recreated by replay once the topic's
-- retention (seven days) has passed. Locks both tables first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender_receipt_link", "bid_access_evidence" IN ACCESS EXCLUSIVE MODE;

DO $preflight_evidence$
DECLARE
  links bigint;
  reads bigint;
BEGIN
  SELECT count(*) INTO links FROM "tender_receipt_link";
  SELECT count(*) INTO reads FROM "bid_access_evidence";
  IF links + reads > 0 THEN
    RAISE EXCEPTION 'down refused: % receipt link(s) and % bid access row(s) exist. They cannot be rebuilt from the topic after its retention, and the chain is the head bids are opened against. Keep this migration, or archive them and decide by hand.', links, reads
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_evidence$;

DROP TRIGGER IF EXISTS "tg_tender_receipt_link_append_only" ON "tender_receipt_link";
DROP TRIGGER IF EXISTS "tg_tender_receipt_link_no_truncate" ON "tender_receipt_link";
DROP TRIGGER IF EXISTS "tg_bid_access_evidence_append_only" ON "bid_access_evidence";
DROP TRIGGER IF EXISTS "tg_bid_access_evidence_no_truncate" ON "bid_access_evidence";
DROP FUNCTION IF EXISTS "tender_evidence_append_only"();

DROP TABLE IF EXISTS "bid_access_evidence";
DROP TABLE IF EXISTS "tender_receipt_link";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261001110000_tender_evidence';

COMMIT;
