-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 4b).
--
-- Drops the key guard and its function, both tables (indexes, CHECKs and
-- tenant-bound foreign keys go with them), then the tender's publication
-- constraints and columns.
--
-- **Refused while any tender key or any invitation exists.** A tender key cannot
-- be recovered once dropped: re-applying this migration would leave published
-- tenders with no private key, and every bid sealed to them unopenable. An
-- invitation can exist with no key (publishing is gated), and dropping it would
-- erase who a restricted tender invited. So the rollback checks first and stops
-- with a message; it never silently destroys either. With neither stored it drops
-- the two tables, the publication constraints and the columns. Events already
-- published from the outbox have left.
--
-- Locks the tender first (as the application does: the tender row, then its key),
-- then the two tables, ACCESS EXCLUSIVE, so no publication can slip a key in
-- between the count and the drop, and none can deadlock it. Atomic.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';

LOCK TABLE "tender", "tender_key", "tender_invitation" IN ACCESS EXCLUSIVE MODE;

DO $preflight_keys$
DECLARE
  keys bigint;
BEGIN
  SELECT count(*) INTO keys FROM "tender_key";
  IF keys > 0 THEN
    RAISE EXCEPTION 'down refused: % tender key(s) exist. A tender key cannot be recovered once dropped, and the published tenders it belongs to would have no private key; their bids could never be opened. Keep this migration, or archive the keys and decide by hand.', keys
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_keys$;

-- An invitation can exist with no key (a restricted draft invites before it is
-- published, and publishing is gated). It is the owner's record of who may bid.
DO $preflight_invitations$
DECLARE
  invitations bigint;
BEGIN
  SELECT count(*) INTO invitations FROM "tender_invitation";
  IF invitations > 0 THEN
    RAISE EXCEPTION 'down refused: % tender invitation(s) exist. Dropping them would erase who was invited to a restricted tender, and nothing recreates them. Keep this migration, or archive the invitations and decide by hand.', invitations
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$preflight_invitations$;

DROP TRIGGER IF EXISTS "tg_tender_key_guard" ON "tender_key";
DROP FUNCTION IF EXISTS "tender_key_guard"();

DROP TABLE IF EXISTS "tender_key";
DROP TABLE IF EXISTS "tender_invitation";

ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_published_after_created";
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_publication_complete";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "published_by";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "published_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930180000_tender_publication';

COMMIT;
