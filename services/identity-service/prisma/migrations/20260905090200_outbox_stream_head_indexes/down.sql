-- Reverses 20260905090200_outbox_stream_head_indexes (ADR-051 Phase B1).
--
-- Once B4 has shipped, roll the code back before this runs: the head-of-line
-- claim query stays correct without these indexes but plans badly, which is
-- the regression they exist to prevent. In B1 they are unreferenced, so this
-- costs nothing.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ix_outbox_head_both";
DROP INDEX IF EXISTS "ix_outbox_head_retry";
DROP INDEX IF EXISTS "ix_outbox_head_lease";
DROP INDEX IF EXISTS "ix_outbox_head_fresh";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260905090200_outbox_stream_head_indexes';
