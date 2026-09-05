-- Reverses 20260905090000_outbox_stream_sequence (ADR-051 Phase B1).
--
-- Safe at any point in B1: nothing writes to this table until B3.
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "outbox_stream_sequence";

-- Prisma will not re-apply a migration whose row is still in its ledger, so a
-- rollback that leaves this behind cannot be rolled forward again.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260905090000_outbox_stream_sequence';
