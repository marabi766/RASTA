-- Reverses 20260929140000_asset_event_position (D-039).
--
-- Roll the code back first: the timeline consumer reads and writes this table.
-- Dropping it loses only the memory of which event set a status last; an event
-- replayed from `.retry` could then move a status back until the next one.
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "asset_event_position";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260929140000_asset_event_position';
