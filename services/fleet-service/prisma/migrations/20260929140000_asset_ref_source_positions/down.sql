-- Reverses 20260929140000_asset_ref_source_positions (D-039).
--
-- Roll the code back first: the asset-sync consumer reads and writes this
-- column. Dropping it loses only the memory of which event set the state last;
-- an event replayed from `.retry` could then set the replica back until the
-- next event of the machine arrives.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" DROP COLUMN IF EXISTS "source_positions";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260929140000_asset_ref_source_positions';
