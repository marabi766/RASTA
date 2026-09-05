-- ADR-051 Phase B1, migration 1 of 3 - the per-stream sequence counter table.
--
-- One row per ordered stream, where a stream is "topic + partition_key" and
-- nothing else. ADR-051 section C-7 measured why the unit is not the aggregate:
-- under ADR-036 the fleet, maintenance and transactional economic families
-- deliberately place events of several aggregates on one key, so a counter
-- keyed by aggregate would not cover the streams ADR-036 built.
--
-- A table rather than a BIGSERIAL, and the reason is the whole decision:
-- nextval() is non-transactional, so a rolled-back transaction burns a number
-- and leaves a permanent gap indistinguishable from a lost event. A row rolls
-- back with its transaction. It also holds its row lock until commit, which is
-- the only mechanism that closes the commit-order divergence measured in
-- ADR-051 section R4 - where the relay published the *later* event first
-- because created_at is taken in JavaScript before COMMIT.
--
-- Service-local by construction (A-01). There is no shared or global counter,
-- and no service reads another service's table.
--
-- This table is INERT in B1. Nothing writes to it; allocation arrives in B3.
-- Creating it first keeps B1 additive and behaviour-neutral, so it can be
-- deployed and rolled back on its own.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "outbox_stream_sequence" (
    "topic"         TEXT   NOT NULL,
    "partition_key" TEXT   NOT NULL,
    "next_seq"      BIGINT NOT NULL DEFAULT 1,
    "published_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_stream_sequence_pkey" PRIMARY KEY ("topic", "partition_key")
);
