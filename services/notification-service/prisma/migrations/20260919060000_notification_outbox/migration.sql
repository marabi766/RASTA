-- NTF-002 / D-011's sibling: notification-service gains a transactional outbox.
--
-- Until now this service consumed events and published none, so it had no
-- outbox at all. Reading and dismissing an in-app notification are state
-- changes, and AGENTS.md S-06 requires every state change to produce an audit
-- record; audit-service's only input is the event log. ADR-054 § 3 recorded
-- that gap as a deviation from a binding rule and refused to accept NTF-002
-- until it closed. This is the table that closes it.
--
-- The DDL is the platform's, copied from supplier-service's init migration
-- rather than reinvented: ADR-050's claim protocol and ADR-051 Phase B1's
-- sequence columns are shared in `@rasta/nest-common`, and a locally-tuned
-- variant is exactly the divergence ADR-050 was written to end.

-- =============================================================================
-- Transactional outbox (ADR-021, ADR-050, ADR-051 Phase B1)
-- =============================================================================

CREATE TABLE "outbox_message" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "organization_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    -- ADR-050 durable claim.
    "claim_token" TEXT,
    "claim_owner" TEXT,
    "claim_expires_at" TIMESTAMP(3),
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),

    -- ADR-051 Phase B3. `stream_seq` is allocated by `allocateStreamSeqSql`
    -- inside the writing transaction; `is_stream_head` stays unset until B4,
    -- because maintaining it would claim a head-of-line guarantee no relay
    -- enforces yet.
    "stream_seq" BIGINT,
    "is_stream_head" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_outbox_pending" ON "outbox_message"("published_at", "created_at");

-- ---- ADR-050 CHECK constraints ----------------------------------------------

-- An active claim carries all three parts or none. Two of three describes a row
-- that has no fence, or no expiry, or looks unowned to the metrics while
-- somebody is publishing it.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_triple"
  CHECK (num_nonnulls("claim_token", "claim_owner", "claim_expires_at") IN (0, 3));

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_count_nonneg"
  CHECK ("claim_count" >= 0);

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_attempts_nonneg"
  CHECK ("attempts" >= 0);

-- A published row holds no claim metadata and no scheduled retry. This is also
-- what makes `purgePublished` safe: it can never delete a row some worker still
-- holds a live lease on.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_published_is_clean"
  CHECK ("published_at" IS NULL
         OR ("claim_token" IS NULL AND "claim_owner" IS NULL
             AND "claim_expires_at" IS NULL AND "next_attempt_at" IS NULL));

-- `next_attempt_at` only means something for an unpublished row that has
-- already failed at least once.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_next_attempt_requires_failure"
  CHECK ("next_attempt_at" IS NULL OR ("published_at" IS NULL AND "attempts" >= 1));

-- ---- ADR-050 claim indexes --------------------------------------------------

CREATE INDEX IF NOT EXISTS "ix_outbox_claimable"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_claim_expiry"
    ON "outbox_message" ("claim_expires_at")
 WHERE "published_at" IS NULL AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_next_attempt"
    ON "outbox_message" ("next_attempt_at")
 WHERE "published_at" IS NULL AND "next_attempt_at" IS NOT NULL;

-- ---- ADR-050 eligibility-stream indexes -------------------------------------
--
-- The four streams `claimPendingSql` selects from. `now()` is stable rather
-- than immutable, so the planner cannot estimate `<= now()` and falls back to
-- 33% selectivity; these remove the estimate from the decision by making each
-- stream's eligibility test either statically true or a range on that index's
-- own leading column.

CREATE INDEX IF NOT EXISTS "ix_outbox_due_fresh"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_lease"
    ON "outbox_message" ("claim_expires_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "next_attempt_at" IS NULL
   AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_retry"
    ON "outbox_message" ("next_attempt_at", "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NULL
   AND "next_attempt_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_due_both"
    ON "outbox_message" ((GREATEST("claim_expires_at", "next_attempt_at")), "created_at", "id")
 WHERE "published_at" IS NULL
   AND "claim_expires_at" IS NOT NULL
   AND "next_attempt_at" IS NOT NULL;

-- ---- ADR-051 Phase B1 -------------------------------------------------------
--
-- The counter table, the partial unique index and the four head indexes, at the
-- definitions `scripts/verify-outbox-b1-lib.mjs` asserts. Every one is inert:
-- `is_stream_head` is false on every row this service writes, so all four head
-- indexes stay empty and no query references them.

CREATE TABLE IF NOT EXISTS "outbox_stream_sequence" (
    "topic"         TEXT   NOT NULL,
    "partition_key" TEXT   NOT NULL,
    "next_seq"      BIGINT NOT NULL DEFAULT 1,
    "published_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_stream_sequence_pkey" PRIMARY KEY ("topic", "partition_key")
);

-- Partial on purpose: `WHERE stream_seq IS NOT NULL`. An unqualified unique
-- index on (topic, partition_key, stream_seq) would reject every second row
-- whose sequence is still NULL — which, since nothing allocates one in this
-- service, is every row after the first per stream. That is a total write
-- outage, and it passes an existence check.
--
-- Not declared in schema.prisma: Prisma has no syntax for an index predicate.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_outbox_stream_seq"
    ON "outbox_message" ("topic", "partition_key", "stream_seq")
 WHERE "stream_seq" IS NOT NULL;

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

