-- ADR-051 Phase B1, migration 3 of 3 - the four head-query indexes.
--
-- Each is exactly its ADR-050 eligibility-stream counterpart with
-- "AND is_stream_head" appended, keeping the same key order, so B4's claim
-- query can narrow to stream heads without changing the plan shape. The
-- pairing is one-to-one and intentional:
--
--   ix_outbox_due_fresh  ->  ix_outbox_head_fresh    no lease, no retry
--   ix_outbox_due_lease  ->  ix_outbox_head_lease    lease only
--   ix_outbox_due_retry  ->  ix_outbox_head_retry    retry only
--   ix_outbox_due_both   ->  ix_outbox_head_both     both present
--
-- These grow with the number of STREAMS, not the number of rows: only one row
-- per stream can be its head, so 2,000 streams means at most 2,000 entries
-- however deep the queue runs. ADR-051 section R10 measured all four at
-- 180,224 bytes (176 KB) on a 200,000-row fixture.
--
-- INERT in B1. is_stream_head is false on every row, so all four are empty and
-- no query references them. They exist now so that B4 is a query change
-- against indexes already built, rather than a schema change under load.
SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS "ix_outbox_head_fresh"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_lease"
    ON "outbox_message" ("claim_expires_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_retry"
    ON "outbox_message" ("next_attempt_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NOT NULL
   AND "is_stream_head";

CREATE INDEX IF NOT EXISTS "ix_outbox_head_both"
    ON "outbox_message" ((GREATEST("claim_expires_at", "next_attempt_at")), "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "next_attempt_at" IS NOT NULL
   AND "is_stream_head";
