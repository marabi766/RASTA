-- ADR-050 — durable outbox claim (D-026 Phase B).
--
-- Additive and compatible: every column is nullable or defaulted, no existing
-- column changes, and no code reads these yet. The running (old) relay keeps
-- working against this schema unchanged, which is what makes the rolling
-- sequence in the ADR safe — schema first, behaviour later.
--
-- `CREATE INDEX CONCURRENTLY` is deliberately NOT used: Prisma Migrate wraps
-- each migration file in a transaction, and PostgreSQL refuses CONCURRENTLY
-- inside one (SQLSTATE 25001). The indexes are created normally, which takes a
-- brief ACCESS EXCLUSIVE lock. That is acceptable only because the table stays
-- structurally small — `purgePublished` deletes published rows older than
-- seven days and unpublished rows drain continuously. The preflight numbers
-- recorded in the PR confirm it for every one of the eight databases.
--
-- For a deployment whose outbox is NOT small (> 1,000,000 rows or > 1 GB), the
-- supported path is to run the three `CREATE INDEX CONCURRENTLY` statements by
-- hand, outside Prisma, before deploying. Every index below is written with
-- `IF NOT EXISTS` precisely so this migration then passes over them instead of
-- rebuilding. Verify a hand-built index by its full definition, not its name:
-- an index with the right name and the wrong predicate is worse than none.
--
-- The three partial indexes and the five CHECK constraints are not expressible
-- in `schema.prisma` (Prisma models neither index predicates nor CHECKs), so
-- they live here only — the same arrangement ADR-049's constraints already use.

-- Fail fast rather than queue forever. CREATE INDEX needs ACCESS EXCLUSIVE; if
-- a long transaction holds the table (a slow relay, a pg_dump, a forgotten
-- session), an unbounded wait would also block every INSERT queueing behind
-- the lock request — a hung migration would stop the outbox being written at
-- all. Three seconds is longer than any healthy lock and shorter than a deploy
-- window. SET LOCAL, so it reverts with this migration's own transaction.
SET LOCAL lock_timeout = '3s';

-- Five columns. Nullable, so existing rows are valid the moment they appear.
ALTER TABLE "outbox_message" ADD COLUMN "claim_token"      TEXT;
ALTER TABLE "outbox_message" ADD COLUMN "claim_owner"      TEXT;
ALTER TABLE "outbox_message" ADD COLUMN "claim_expires_at" TIMESTAMP(3);
ALTER TABLE "outbox_message" ADD COLUMN "claim_count"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "outbox_message" ADD COLUMN "next_attempt_at"  TIMESTAMP(3);

-- An active claim carries all three parts or none. Two of three describes a
-- row that has no fence, or no expiry, or looks unowned to the metrics while
-- somebody is publishing it.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_triple"
  CHECK (num_nonnulls("claim_token", "claim_owner", "claim_expires_at") IN (0, 3));

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_claim_count_nonneg"
  CHECK ("claim_count" >= 0);

ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_attempts_nonneg"
  CHECK ("attempts" >= 0);

-- A published row holds no claim metadata — `claim_owner` included — and no
-- scheduled retry. This is also what makes `purgePublished` safe: it can never
-- delete a row that some worker still holds a live lease on.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_published_is_clean"
  CHECK ("published_at" IS NULL
         OR ("claim_token" IS NULL AND "claim_owner" IS NULL
             AND "claim_expires_at" IS NULL AND "next_attempt_at" IS NULL));

-- `next_attempt_at` only means something for an unpublished row that has
-- already failed at least once. A retry scheduled with no prior attempt is
-- data no code path produces.
ALTER TABLE "outbox_message" ADD CONSTRAINT "ck_outbox_next_attempt_requires_failure"
  CHECK ("next_attempt_at" IS NULL OR ("published_at" IS NULL AND "attempts" >= 1));

-- The claim query's ordering, over only the rows it can ever return.
CREATE INDEX IF NOT EXISTS "ix_outbox_claimable"
    ON "outbox_message" ("created_at", "id")
 WHERE "published_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_claim_expiry"
    ON "outbox_message" ("claim_expires_at")
 WHERE "published_at" IS NULL AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_outbox_next_attempt"
    ON "outbox_message" ("next_attempt_at")
 WHERE "published_at" IS NULL AND "next_attempt_at" IS NOT NULL;
