-- Reverses 20260905090100_outbox_stream_seq_columns (ADR-051 Phase B1).
--
-- Index before columns: dropping a column cascades its indexes away silently,
-- and an explicit DROP INDEX keeps the reversal auditable.
--
-- No data is lost in B1, because nothing has written these columns yet. After
-- B2 has backfilled, this rollback discards the sequence numbers and B2 must
-- be re-run.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ux_outbox_stream_seq";

ALTER TABLE "outbox_message" DROP COLUMN IF EXISTS "is_stream_head";
ALTER TABLE "outbox_message" DROP COLUMN IF EXISTS "stream_seq";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260905090100_outbox_stream_seq_columns';
