-- ADR-051 Phase B1, migration 2 of 3 - the two inert outbox columns.
--
-- stream_seq is deliberately NULLABLE and deliberately not backfilled here.
-- Every row already in the table predates sequencing; making the column NOT
-- NULL would require a backfill inside this migration, and ADR-051 section R7
-- measured that a single in-place UPDATE roughly doubles the table. The
-- backfill is B2: batched, with intervening VACUUM.
--
-- is_stream_head defaults to false and stays false for the whole of B1. It is
-- the materialised head flag from ADR-051 section R10: the naive head-of-line
-- JOIN against the counter table scanned 198,000 rows in 1091 ms to return
-- zero, against 0.012 ms and one buffer for a partial index on this flag. B4
-- maintains the flag; B1 only creates it.
--
-- The unique index is partial - WHERE stream_seq IS NOT NULL - precisely so
-- the pre-sequencing rows stay valid through the B2 backfill window. It is the
-- invariant that makes a duplicate sequence number within one stream
-- impossible rather than merely unlikely.
--
-- Not declared in schema.prisma: Prisma has no syntax for a partial index, and
-- declaring it unqualified would ask Prisma to build a *full* unique index on
-- (topic, partition_key, stream_seq), which would reject every second row
-- whose stream_seq is still NULL. The four ADR-050 eligibility indexes live in
-- migrations only, for the same reason.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "outbox_message" ADD COLUMN IF NOT EXISTS "stream_seq" BIGINT;
ALTER TABLE "outbox_message"
    ADD COLUMN IF NOT EXISTS "is_stream_head" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "ux_outbox_stream_seq"
    ON "outbox_message" ("topic", "partition_key", "stream_seq")
 WHERE "stream_seq" IS NOT NULL;
