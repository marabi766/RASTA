-- Reverse of `migration.sql` (20261016140000_settlement_authorisation_command).
--
-- Drops the proof of which service command authorised a transaction. Run with
-- the previous release deployed: it neither writes nor reads them. An order
-- saga whose authorisation was then disputed and whose retry comes after the
-- stored answer expired is refused again, as before (docs/23 D-053).
BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "transaction"
  DROP COLUMN IF EXISTS "settlement_authorisation_key",
  DROP COLUMN IF EXISTS "settlement_authorised_service";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016140000_settlement_authorisation_command';

COMMIT;
