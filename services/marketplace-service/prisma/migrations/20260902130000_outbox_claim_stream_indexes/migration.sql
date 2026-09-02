-- ADR-050 — the four eligibility-stream indexes (D-026 Phase B, round two).
--
-- The claim query's original single predicate met the ADR's correctness bar and
-- failed its performance bar: with most rows carrying a live lease or a pending
-- retry it removed 190,000 rows by filter against a ceiling of 10 x LIMIT.
--
-- The cause is not a missing index. `now()` is stable, not immutable, so its
-- value is unknown at planning time; PostgreSQL cannot consult a histogram for
-- `<= now()` and applies the 33% default. Measured: an expression index on
-- GREATEST(COALESCE(...), COALESCE(...)) *does* get statistics (n_distinct = 2
-- in pg_stats) and the planner still estimated 66,667 of 200,000. With
-- LIMIT 100 an early exit from the ordering index then always wins, so the plan
-- walks (created_at, id) and filters.
--
-- These four indexes remove the estimate from the decision. Every unpublished
-- row belongs to exactly one of them, and in each the eligibility test is
-- either statically true or a range on the index's own leading column:
--
--   fresh   no lease, no retry     -> always eligible; pure ordering
--   lease   lease only             -> range on claim_expires_at
--   retry   retry only             -> range on next_attempt_at
--   paired  both present           -> range on GREATEST(lease, retry)
--
-- Separate from the first migration rather than folded into it: that one is
-- already applied and verified, and the rolling sequence wants the indexes in
-- place before the query that needs them ships.
--
-- Cost, measured on a 200,000-row fixture: about 10.4 MB of additional index
-- against a 27 MB table (total index size 21 MB -> 31 MB). Every claim and
-- every renewal writes claim_expires_at, so those writes now maintain more
-- index; that is the trade recorded for review in the implementation plan.
SET LOCAL lock_timeout = '3s';

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
