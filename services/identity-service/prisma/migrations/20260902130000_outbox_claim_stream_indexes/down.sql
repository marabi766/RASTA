-- Reverses 20260902130000_outbox_claim_stream_indexes (ADR-050).
--
-- Roll the code back before this runs: the four-stream claim query is correct
-- without these indexes but plans badly, which is the performance regression
-- they exist to prevent, not a failure.
SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "ix_outbox_due_both";
DROP INDEX IF EXISTS "ix_outbox_due_retry";
DROP INDEX IF EXISTS "ix_outbox_due_lease";
DROP INDEX IF EXISTS "ix_outbox_due_fresh";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260902130000_outbox_claim_stream_indexes';
