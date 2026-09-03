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
-- Each stream also takes FOR UPDATE SKIP LOCKED before its own LIMIT, so a
-- claimant meeting a contended prefix keeps scanning and still fills its
-- batch. Locking only after the candidate merge starved: two claimants build
-- the same pre-limited window, and the second found every candidate held.
-- Measured before the fix — 300 eligible rows, oldest 100 locked elsewhere,
-- claimPending(100) returned 0.
--
-- Cost, measured once on a 200,000-row fixture with all four streams
-- populated (194,000 fresh / 2,000 lease / 2,000 retry / 2,000 paired):
--
--   table                       18 MB   (18,653,184 bytes)
--   indexes before this file    27.8 MB (29,106,176 bytes)
--   indexes after this file     35.6 MB (37,355,520 bytes)
--   these four indexes           7.87 MB (8,249,344 bytes)  -> +28.3%
--
-- of which ix_outbox_due_fresh is 7696 kB and the other three are 120 kB
-- each, because almost every unpublished row is in the fresh stream. Every
-- claim and every renewal writes claim_expires_at, so those writes now
-- maintain more index; that is the trade recorded for review in the
-- implementation plan.
--
-- Lock amplification is the other cost: four streams can each lock up to
-- LIMIT, so up to 4 x LIMIT rows are locked while only LIMIT are claimed —
-- measured at 400 locked / 100 claimed with every stream populated. The locks
-- are held for this one statement only.
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
