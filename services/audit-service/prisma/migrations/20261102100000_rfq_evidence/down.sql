-- =============================================================================
-- Reverse of `migration.sql` (the RFQ-evidence projection).
--
-- **Refused while any evidence exists.** The receipt chain held here is the
-- externally kept head quotations are opened against; it cannot be recreated by
-- replay once the topic's retention (seven days) has passed. A held receipt is
-- evidence of a gap and is refused the same way. Locks both tables first; atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "rfq_receipt_link", "rfq_receipt_pending" IN ACCESS EXCLUSIVE MODE;

DO $preflight_rfq_evidence$
DECLARE
  links bigint;
  held bigint;
BEGIN
  SELECT count(*) INTO links FROM "rfq_receipt_link";
  SELECT count(*) INTO held FROM "rfq_receipt_pending";
  IF links + held > 0 THEN
    RAISE EXCEPTION 'down refused: % receipt link(s) and % held receipt(s) exist. They cannot be rebuilt from the topic after its retention, and the chain is the head quotations are opened against. Keep this migration, or archive them and decide by hand.', links, held
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_rfq_evidence$;

DROP TRIGGER IF EXISTS "tg_rfq_receipt_link_append_only" ON "rfq_receipt_link";
DROP TRIGGER IF EXISTS "tg_rfq_receipt_link_no_truncate" ON "rfq_receipt_link";
DROP FUNCTION IF EXISTS "rfq_evidence_append_only"();

DROP TABLE IF EXISTS "rfq_receipt_pending";
DROP TABLE IF EXISTS "rfq_receipt_link";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261102100000_rfq_evidence';

COMMIT;
