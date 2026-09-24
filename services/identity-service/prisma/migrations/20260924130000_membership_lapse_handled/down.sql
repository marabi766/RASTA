-- Reverses 20260924130000_membership_lapse_handled.
--
-- Loses only the sweep's bookkeeping. After a rollback the previous release
-- does not run the sweep at all, and on a roll forward every lapsed membership
-- is visited once more: the active organization is already moved, so the
-- repeat publishes a second MEMBERSHIP_EXPIRED for it and re-projects a user
-- whose attributes are already right. Harmless, and preferable to guessing
-- which lapses were handled.
DROP INDEX IF EXISTS "ix_membership_lapse_pending";
ALTER TABLE "membership" DROP COLUMN IF EXISTS "lapse_handled_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260924130000_membership_lapse_handled';
