-- =============================================================================
-- Reverse of `migration.sql` (CON-002 PR 4b).
--
-- Drops the key guard and its function, both tables (indexes, CHECKs and
-- tenant-bound foreign keys go with them), then the tender's publication
-- constraints and columns.
--
-- **This destroys every tender key, every invitation and every publication
-- record this service has stored.** A tender key cannot be recovered once
-- dropped: bids sealed to it become unopenable. Do not run this against data that
-- matters. Events already published from the outbox have left.
--
-- The `_prisma_migrations` row is removed last so the forward migration can be
-- re-applied.
-- =============================================================================

DROP TRIGGER IF EXISTS "tg_tender_key_guard" ON "tender_key";
DROP FUNCTION IF EXISTS "tender_key_guard"();

DROP TABLE IF EXISTS "tender_key";
DROP TABLE IF EXISTS "tender_invitation";

ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_published_after_created";
ALTER TABLE "tender" DROP CONSTRAINT IF EXISTS "ck_tender_publication_complete";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "published_by";
ALTER TABLE "tender" DROP COLUMN IF EXISTS "published_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260930180000_tender_publication';
