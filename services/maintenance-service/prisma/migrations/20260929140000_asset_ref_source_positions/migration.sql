-- Where in the producer's stream the replica's state was last set (D-039).
--
-- `<topic>` and `<topic>.retry` are separate streams, so a replayed event can
-- arrive after a newer one; without a stored position the replay would set the
-- replica's status back. One jsonb value per row,
-- `{ "asset-service": { seq, streamKey, at, eventId } }`. A constant default:
-- PostgreSQL adds the column without rewriting the table, and existing rows
-- read as "no position yet", i.e. the first event applies.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "asset_ref" ADD COLUMN "source_positions" JSONB NOT NULL DEFAULT '{}';
