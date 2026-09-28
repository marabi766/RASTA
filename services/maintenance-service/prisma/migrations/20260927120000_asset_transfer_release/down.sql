-- Reverses 20260927120000_asset_transfer_release (ADR-062).
--
-- Roll the code back first: the clearance and the release read and write
-- this table. Dropping it loses only the memory of released transfers; a
-- clearance delayed past its own release could then fence the machine until
-- the fence expires and is resolved at its source.
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "asset_transfer_release";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260927120000_asset_transfer_release';
