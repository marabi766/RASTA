-- =============================================================================
-- contract-service — initial migration (CON-003 PR 1, ADR-068).
--
-- The draft contract an awarded tender creates, and the platform's outbox. The
-- outbox arrives folded into this one migration, as supplier-service's and
-- construction-service's did: its objects are verified by
-- `scripts/verify-migration-reversible.mjs contract` (EXPECTED.contract), not by
-- the by-name outbox verifiers (`verify-outbox-claim-migration.mjs` lists it as folded).
--
-- Every instant is TIMESTAMPTZ(3) from the start (D-048): this service has no
-- legacy `timestamp without time zone` column.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'SIGNED', 'COMPLETED', 'SETTLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "contract" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tender_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "winning_bid_id" TEXT NOT NULL,
    "contractor_organization_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "matrix_digest" TEXT NOT NULL,
    "awarded_by" TEXT NOT NULL,
    "awarded_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "status_changed_by" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_correlation_id" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "claim_token" TEXT,
    "claim_owner" TEXT,
    "claim_expires_at" TIMESTAMPTZ(3),
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "stream_seq" BIGINT,
    "is_stream_head" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_stream_sequence" (
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "next_seq" BIGINT NOT NULL DEFAULT 1,
    "published_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_stream_sequence_pkey" PRIMARY KEY ("topic","partition_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_contract_org_tender" ON "contract"("organization_id", "tender_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_contract_org_id" ON "contract"("organization_id", "id");

-- CreateIndex
CREATE INDEX "ix_contract_org_status" ON "contract"("organization_id", "status", "id");

-- CreateIndex
CREATE INDEX "ix_contract_contractor" ON "contract"("contractor_organization_id", "id");

-- CreateIndex
CREATE INDEX "ix_outbox_pending" ON "outbox_message"("published_at", "created_at");

-- =============================================================================
-- Domain invariants the database keeps, whatever a future write path forgets
-- =============================================================================

-- ---- contract -----------------------------------------------------------------

-- Every identifier the draft was made from is present: a blank one names nothing.
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_text_not_blank"
  CHECK (btrim("organization_id") <> '' AND btrim("tender_id") <> ''
         AND btrim("project_id") <> '' AND btrim("winning_bid_id") <> ''
         AND btrim("contractor_organization_id") <> '');

-- The price is strictly positive: the award refuses nothing else, and a contract
-- for nothing is not a contract (Q-95 (5)). Money is a bigint of minor units.
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_amount_positive"
  CHECK ("amount_minor" > 0);

-- The two parties are two organizations (a tender's owner never bids on its own tender).
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_parties_distinct"
  CHECK ("contractor_organization_id" <> "organization_id");

-- The decision the draft came from is a SHA-256 digest, lower-case hex.
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_matrix_digest"
  CHECK ("matrix_digest" ~ '^[0-9a-f]{64}$');

-- Every change names who made it (AGENTS.md S-06) and the event it came from.
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_actor_recorded"
  CHECK (btrim("awarded_by") <> '' AND btrim("created_by") <> ''
         AND btrim("status_changed_by") <> '' AND btrim("created_correlation_id") <> ''
         AND btrim("source_event_id") <> '');

ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_version_positive"
  CHECK ("version" >= 1);

-- Nothing about a contract predates its creation.
ALTER TABLE "contract" ADD CONSTRAINT "ck_contract_timestamps_ordered"
  CHECK ("updated_at" >= "created_at" AND "status_changed_at" >= "created_at");

-- ---- what a contract is made of never changes ---------------------------------
--
-- A contract is the record of a decision somebody else made (the award) and a price
-- somebody else stated: its origin is fixed at creation. What a later change may
-- touch is its status and version (and, in later migrations, its children); a
-- contract is never deleted or truncated — an audit reads it. The runtime role owns
-- nothing and cannot disable this (D-045).

CREATE FUNCTION "contract_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."tender_id" IS DISTINCT FROM OLD."tender_id"
       OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
       OR NEW."winning_bid_id" IS DISTINCT FROM OLD."winning_bid_id"
       OR NEW."contractor_organization_id" IS DISTINCT FROM OLD."contractor_organization_id"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."matrix_digest" IS DISTINCT FROM OLD."matrix_digest"
       OR NEW."awarded_by" IS DISTINCT FROM OLD."awarded_by"
       OR NEW."awarded_at" IS DISTINCT FROM OLD."awarded_at"
       OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_correlation_id" IS DISTINCT FROM OLD."created_correlation_id"
    THEN
      RAISE EXCEPTION 'ck_contract_origin_immutable: what a contract was made from never changes'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_contract_not_erasable: a contract is never deleted or truncated (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_contract_guard"
  BEFORE UPDATE OR DELETE ON "contract"
  FOR EACH ROW EXECUTE FUNCTION "contract_guard"();

CREATE TRIGGER "tg_contract_no_truncate"
  BEFORE TRUNCATE ON "contract"
  FOR EACH STATEMENT EXECUTE FUNCTION "contract_guard"();

-- =============================================================================
-- Transactional outbox — the claim and stream objects Prisma cannot declare
-- =============================================================================

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

-- ---- ADR-051 -----------------------------------------------------------------
--
-- The partial unique index and the four head indexes, at the definitions
-- `scripts/verify-outbox-b1-lib.mjs` asserts. The head indexes stay empty:
-- `is_stream_head` is false on every row this service writes (B4 is not merged).

-- Partial on purpose: `WHERE stream_seq IS NOT NULL`. An unqualified unique
-- index on (topic, partition_key, stream_seq) would reject every second row
-- whose sequence is still NULL. That is a total write outage, and it passes an
-- existence check.
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
